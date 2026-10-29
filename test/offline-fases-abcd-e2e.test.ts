import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHmac } from "node:crypto";
import type { Server } from "http";

import { createApp } from "../src/app";
import { prisma } from "../src/config/database";
import { env } from "../src/config/env";
import { securityService } from "../src/modules/auth/services/security.service";
import { offlineAuthService } from "../src/modules/auth/services/offline-auth.service";
import { inspeccionesLegacyService } from "../src/modules/inspecciones/services/inspecciones-legacy.service";

import {
  idbDatabase,
  IDB_NAME,
  IDB_VERSION,
  type ColaInspeccionStore,
  type InspectorOfflineStore,
  type LoteOfflineStore,
  type DefectoOfflineStore,
  type SesionOfflineStore,
  type TerminalProfileStore,
  IdbStorageError,
} from "../../frontend/src/lib/db/idb-database";
import {
  offlineAuthClientService,
  deriveOfflineVerifierBrowser,
  timingSafeEqualHex,
} from "../../frontend/src/features/auth/services/offline-crypto.service";
import { catalogoOfflineService } from "../../frontend/src/features/catalogo-offline/services/catalogo-offline.service";
import {
  inspeccionesOfflineService,
  computeCanonicalPayloadHash,
  computeLocalRowId,
} from "../../frontend/src/features/inspecciones/services/inspecciones-offline.service";
import { httpClient, authState, connectivityState } from "../../frontend/src/lib/api/http-client";
import { terminalStorage } from "../../frontend/src/features/terminales/services/terminal-storage";
import { env as frontendEnv } from "../../frontend/src/config/env";

/**
 * Polyfill completo de IndexedDB en memoria (compatible con versión v1 -> v2, transacciones,
 * índices únicos/no-únicos y simulación de QuotaExceededError e indisponibilidad) para verificar
 * los servicios reales del cliente en entorno Bun + servidor Express/MySQL real.
 */
class FakeIDBIndex {
  public readonly name: string;
  public readonly keyPath: string;
  public readonly unique: boolean;
  private store: FakeIDBObjectStore;

  constructor(store: FakeIDBObjectStore, name: string, keyPath: string, unique: boolean) {
    this.store = store;
    this.name = name;
    this.keyPath = keyPath;
    this.unique = unique;
  }

  get(key: any): any {
    const req: any = { result: undefined, error: null, onsuccess: null, onerror: null };
    queueMicrotask(() => {
      try {
        for (const val of this.store._records.values()) {
          if (val && val[this.keyPath] === key) {
            req.result = structuredClone(val);
            break;
          }
        }
        req.onsuccess?.({ target: req });
      } catch (err) {
        req.error = err;
        req.onerror?.({ target: req });
      }
    });
    return req;
  }
}

class FakeIDBObjectStore {
  public readonly name: string;
  public readonly keyPath: string;
  public _records = new Map<any, any>();
  public _indexes = new Map<string, FakeIDBIndex>();
  public tx: FakeIDBTransaction | null = null;

  constructor(name: string, keyPath: string) {
    this.name = name;
    this.keyPath = keyPath;
  }

  get indexNames() {
    const names = Array.from(this._indexes.keys());
    return {
      contains: (n: string) => this._indexes.has(n),
      length: names.length,
      item: (i: number) => names[i] ?? null,
    };
  }

  createIndex(name: string, keyPath: string, options?: { unique?: boolean }) {
    const idx = new FakeIDBIndex(this, name, keyPath, Boolean(options?.unique));
    this._indexes.set(name, idx);
    return idx;
  }

  index(name: string) {
    const idx = this._indexes.get(name);
    if (!idx) throw new Error(`Index ${name} no existe en ${this.name}`);
    return idx;
  }

  get(key: any) {
    const req: any = { result: undefined, error: null, onsuccess: null, onerror: null };
    queueMicrotask(() => {
      req.result = this._records.has(key) ? structuredClone(this._records.get(key)) : undefined;
      req.onsuccess?.({ target: req });
      this.tx?._checkComplete();
    });
    return req;
  }

  getAll() {
    const req: any = { result: [], error: null, onsuccess: null, onerror: null };
    queueMicrotask(() => {
      req.result = Array.from(this._records.values()).map((v) => structuredClone(v));
      req.onsuccess?.({ target: req });
      this.tx?._checkComplete();
    });
    return req;
  }

  put(value: any) {
    const req: any = { result: undefined, error: null, onsuccess: null, onerror: null };
    this.tx?._enqueueOp(() => {
      if (FakeIndexedDBEngine.simulateQuotaExceeded) {
        const quotaErr = new Error("QuotaExceededError: The quota has been exceeded.");
        quotaErr.name = "QuotaExceededError";
        req.error = quotaErr;
        req.onerror?.({ target: req });
        throw quotaErr;
      }
      const key = value[this.keyPath];
      this._records.set(key, structuredClone(value));
      req.result = key;
      req.onsuccess?.({ target: req });
    });
    return req;
  }

  delete(key: any) {
    const req: any = { result: undefined, error: null, onsuccess: null, onerror: null };
    this.tx?._enqueueOp(() => {
      this._records.delete(key);
      req.onsuccess?.({ target: req });
    });
    return req;
  }

  clear() {
    const req: any = { result: undefined, error: null, onsuccess: null, onerror: null };
    this.tx?._enqueueOp(() => {
      this._records.clear();
      req.onsuccess?.({ target: req });
    });
    return req;
  }
}

class FakeIDBTransaction {
  public oncomplete: (() => void) | null = null;
  public onerror: (() => void) | null = null;
  public onabort: (() => void) | null = null;
  public error: any = null;
  private db: FakeIDBDatabaseInstance;
  private ops: Array<() => void> = [];
  private scheduled = false;

  constructor(db: FakeIDBDatabaseInstance) {
    this.db = db;
    this._scheduleFinish();
  }

  objectStore(name: string): FakeIDBObjectStore {
    const store = this.db._stores.get(name);
    if (!store) throw new Error(`ObjectStore ${name} no existe`);
    const proxy = Object.create(store) as FakeIDBObjectStore;
    proxy.tx = this;
    return proxy;
  }

  _enqueueOp(fn: () => void) {
    this.ops.push(fn);
    this._scheduleFinish();
  }

  _checkComplete() {
    this._scheduleFinish();
  }

  private _scheduleFinish() {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      // Tomar snapshot para revertir si la transacción falla a mitad
      const backup = new Map<string, Map<any, any>>();
      for (const [sName, sObj] of this.db._stores.entries()) {
        backup.set(sName, new Map(sObj._records));
      }

      try {
        while (this.ops.length > 0) {
          const op = this.ops.shift()!;
          op();
        }
        this.oncomplete?.();
      } catch (err) {
        for (const [sName, mapCopy] of backup.entries()) {
          const sObj = this.db._stores.get(sName);
          if (sObj) sObj._records = mapCopy;
        }
        this.error = err;
        this.onerror?.();
      }
    });
  }
}

class FakeIDBDatabaseInstance {
  public readonly name: string;
  public version: number;
  public _stores = new Map<string, FakeIDBObjectStore>();

  constructor(name: string, version: number) {
    this.name = name;
    this.version = version;
  }

  get objectStoreNames() {
    const names = Array.from(this._stores.keys());
    return {
      contains: (n: string) => this._stores.has(n),
      length: names.length,
      item: (i: number) => names[i] ?? null,
    };
  }

  createObjectStore(name: string, options: { keyPath: string }) {
    const store = new FakeIDBObjectStore(name, options.keyPath);
    this._stores.set(name, store);
    return store;
  }

  transaction(_storeNames: string | string[], _mode?: string) {
    return new FakeIDBTransaction(this);
  }

  close() {
    // No-op en memoria
  }
}

class FakeIndexedDBEngine {
  public static databases = new Map<string, FakeIDBDatabaseInstance>();
  public static simulateQuotaExceeded = false;

  static resetAll() {
    this.databases.clear();
    this.simulateQuotaExceeded = false;
  }

  static open(name: string, version: number = 1) {
    const req: any = {
      result: null,
      error: null,
      transaction: null,
      onupgradeneeded: null,
      onsuccess: null,
      onerror: null,
      onblocked: null,
    };

    queueMicrotask(() => {
      try {
        let db = this.databases.get(name);
        const oldVersion = db ? db.version : 0;
        if (!db) {
          db = new FakeIDBDatabaseInstance(name, version);
          this.databases.set(name, db);
        }

        if (version > oldVersion) {
          db.version = version;
          const upgradeTx = new FakeIDBTransaction(db);
          req.result = db;
          req.transaction = upgradeTx;
          req.onupgradeneeded?.({
            target: req,
            oldVersion,
            newVersion: version,
          });
        } else {
          req.result = db;
        }

        queueMicrotask(() => {
          req.onsuccess?.({ target: req });
        });
      } catch (err) {
        req.error = err;
        req.onerror?.({ target: req });
      }
    });

    return req;
  }
}

describe("Fases A, B, C y D — Suite Integral de Continuidad Operativa Offline-First (24 Escenarios Obligatorios)", () => {
  let appServer: Server;
  let baseUrl: string;
  let legacyTempDir: string;

  let deptoMontadoId: number;
  let deptoCorteId: number;
  let deptoAviosId: number;
  let deptoAdornoId: number;

  let terminalMontado: { id: number; nombre: string; credencial: string; departamentoId: number };
  let terminalAvios: { id: number; nombre: string; credencial: string; departamentoId: number };
  let terminalAdorno: { id: number; nombre: string; credencial: string; departamentoId: number };

  let superAdminToken: string;
  let juanito: { id: number; usuario: string; nombre: string; password: string; token: string };
  let jose: { id: number; usuario: string; nombre: string; password: string; token: string };
  let coordUser: { id: number; usuario: string; nombre: string; password: string };

  let lotePrueba: { id: number; lote: string; cantidad: number; modelo: string; lista: string };
  let defectoMontado1: { id: number; clave: number; defecto: string };
  let defectoMontado2: { id: number; clave: number; defecto: string };
  let defectoAvios1: { id: number; clave: number; defecto: string };
  let defectoAdorno1: { id: number; clave: number; defecto: string };

  const api = async (
    method: string,
    path: string,
    opts: { token?: string | null; terminalCred?: string | null; body?: unknown; headers?: Record<string, string> } = {},
  ) => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    };
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    if (opts.terminalCred) headers["x-terminal-credential"] = opts.terminalCred;

    const res = await fetch(`${baseUrl}/api/v1${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const json = (await res.json().catch(() => ({}))) as any;
    return { status: res.status, json, headers: res.headers };
  };

  const asegurarUsuario = async (
    usuario: string,
    nombre: string,
    rolCodigo: string,
    password: string,
    estado: "ACTIVO" | "INACTIVO" = "ACTIVO",
  ) => {
    const rol = await prisma.rol.findUniqueOrThrow({ where: { codigo: rolCodigo } });
    const passwordHash = securityService.hashPassword(password);
    let u = await prisma.usuario.findFirst({ where: { usuario } });
    if (!u) {
      u = await prisma.usuario.create({
        data: { usuario, nombre, passwordHash, rolId: rol.id, estado },
      });
    } else {
      u = await prisma.usuario.update({
        where: { id: u.id },
        data: { nombre, passwordHash, rolId: rol.id, estado },
      });
    }

    let token = "";
    if (estado === "ACTIVO") {
      const login = await api("POST", "/auth/login", { body: { usuario, password } });
      token = login.json?.data?.accessToken || "";
    }
    return { id: u.id, usuario, nombre, password, token };
  };

  beforeAll(async () => {
    // 1. Instalar polyfill de IndexedDB y entorno de navegador para servicios frontend
    (globalThis as any).indexedDB = FakeIndexedDBEngine;
    (globalThis as any).window = globalThis;
    if (!(globalThis as any).localStorage) {
      const store = new Map<string, string>();
      (globalThis as any).localStorage = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => store.set(k, String(v)),
        removeItem: (k: string) => store.delete(k),
        clear: () => store.clear(),
      };
    }

    // 2. Configurar directorio temporal aislado para archivos TXT legacy
    legacyTempDir = mkdtempSync(join(tmpdir(), "mbc_offline_legacy_test_"));
    inspeccionesLegacyService.setBaseDir(legacyTempDir);

    // 3. Levantar servidor Express real
    const app = createApp();
    appServer = app.listen(0);
    const addr = appServer.address() as any;
    baseUrl = `http://127.0.0.1:${addr.port}`;
    (frontendEnv as any).API_BASE_URL = `${baseUrl}/api/v1`;

    // 4. Autenticar superadmin y preparar departamentos, terminales, usuarios y catálogos
    const loginAdmin = await api("POST", "/auth/login", {
      body: { usuario: "admin", password: "Deadmau6" },
    });
    superAdminToken = loginAdmin.json.data.accessToken;

    const deptos = await prisma.departamento.findMany({ where: { estado: "ACTIVO" } });
    const montado = deptos.find((d) => d.codigo === "MONTADO")!;
    const corte = deptos.find((d) => d.codigo === "CORTE")!;
    const avios = deptos.find((d) => d.codigo === "AVIOS")!;
    const adorno = deptos.find((d) => d.codigo === "ADORNO")!;

    deptoMontadoId = montado.id;
    deptoCorteId = corte.id;
    deptoAviosId = avios.id;
    deptoAdornoId = adorno.id;

    // Crear terminales físicas vinculadas para MONTADO, AVIOS y ADORNO
    const tMontadoRes = await api("POST", "/terminales", {
      token: superAdminToken,
      body: { nombre: `PC-MONTADO-OFF-${Date.now()}`, departamentoId: deptoMontadoId },
    });
    terminalMontado = {
      id: tMontadoRes.json.data.terminal.id,
      nombre: tMontadoRes.json.data.terminal.nombre,
      credencial: tMontadoRes.json.data.credencial,
      departamentoId: deptoMontadoId,
    };

    const tAviosRes = await api("POST", "/terminales", {
      token: superAdminToken,
      body: { nombre: `PC-AVIOS-OFF-${Date.now()}`, departamentoId: deptoAviosId },
    });
    terminalAvios = {
      id: tAviosRes.json.data.terminal.id,
      nombre: tAviosRes.json.data.terminal.nombre,
      credencial: tAviosRes.json.data.credencial,
      departamentoId: deptoAviosId,
    };

    const tAdornoRes = await api("POST", "/terminales", {
      token: superAdminToken,
      body: { nombre: `PC-ADORNO-OFF-${Date.now()}`, departamentoId: deptoAdornoId },
    });
    terminalAdorno = {
      id: tAdornoRes.json.data.terminal.id,
      nombre: tAdornoRes.json.data.terminal.nombre,
      credencial: tAdornoRes.json.data.credencial,
      departamentoId: deptoAdornoId,
    };

    // Crear inspectores Juanito y José + coordinador sin permiso de captura
    juanito = await asegurarUsuario(
      "juanito_offline",
      "JUANITO PEREZ INSPECTOR",
      "INSPECTOR",
      "JuanitoPass2026!",
    );
    jose = await asegurarUsuario(
      "jose_offline",
      "JOSE LOPEZ INSPECTOR",
      "INSPECTOR",
      "JosePass2026!",
    );
    coordUser = await asegurarUsuario(
      "coord_offline",
      "CARLOS COORDINADOR",
      "COORD",
      "CoordPass2026!",
    );

    // Lote activo para pruebas
    const l = await prisma.produccionLote.findFirstOrThrow({
      where: { estado: "ACTIVO", eliminadoEn: null, cantidad: { gte: 10 } },
      orderBy: { id: "desc" },
    });
    lotePrueba = {
      id: l.id,
      lote: l.lote,
      cantidad: Number(l.cantidad),
      modelo: l.modelo,
      lista: l.lista,
    };

    // Defectos permitidos por etapa
    const defMontadoList = await prisma.defectoEtapa.findMany({
      where: {
        departamentoId: deptoMontadoId,
        permitido: true,
        defecto: { activo: true, eliminadoEn: null },
      },
      include: { defecto: true },
      take: 2,
    });
    defectoMontado1 = {
      id: defMontadoList[0]!.defecto.id,
      clave: defMontadoList[0]!.defecto.clave,
      defecto: defMontadoList[0]!.defecto.defecto,
    };
    defectoMontado2 = {
      id: defMontadoList[1]!.defecto.id,
      clave: defMontadoList[1]!.defecto.clave,
      defecto: defMontadoList[1]!.defecto.defecto,
    };

    const defAvios = await prisma.defectoEtapa.findFirstOrThrow({
      where: {
        departamentoId: deptoAviosId,
        permitido: true,
        defecto: { activo: true, eliminadoEn: null },
      },
      include: { defecto: true },
    });
    defectoAvios1 = {
      id: defAvios.defecto.id,
      clave: defAvios.defecto.clave,
      defecto: defAvios.defecto.defecto,
    };

    const defAdorno = await prisma.defectoEtapa.findFirstOrThrow({
      where: {
        departamentoId: deptoAdornoId,
        permitido: true,
        defecto: { activo: true, eliminadoEn: null },
      },
      include: { defecto: true },
    });
    defectoAdorno1 = {
      id: defAdorno.defecto.id,
      clave: defAdorno.defecto.clave,
      defecto: defAdorno.defecto.defecto,
    };
  });

  afterAll(async () => {
    if (appServer) {
      await new Promise((resolve) => appServer.close(resolve));
    }
    if (legacyTempDir && existsSync(legacyTempDir)) {
      rmSync(legacyTempDir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // ESCENARIOS 1 A 5 — FASE A: CORRECCIÓN DE CATÁLOGOS, WATERMARK E INDEXEDDB
  // =========================================================================

  it("Escenario 1: GET /api/v1/defectos?etapaId=... filtra realmente por etapa y el cliente consume respuesta paginada completa", async () => {
    const resMontado = await api("GET", `/defectos?etapaId=${deptoMontadoId}&activo=true&limit=200`, {
      token: juanito.token,
    });
    expect(resMontado.status).toBe(200);
    expect(Array.isArray(resMontado.json.data.items)).toBe(true);
    expect(typeof resMontado.json.data.total).toBe("number");
    expect(typeof resMontado.json.data.totalPages).toBe("number");

    const resCorte = await api("GET", `/defectos?etapaId=${deptoCorteId}&activo=true&limit=200`, {
      token: juanito.token,
    });
    expect(resCorte.status).toBe(200);

    // Verificar en BD que todos los defectos devueltos tengan etapa permitida en deptoMontadoId
    const idsDevueltos = resMontado.json.data.items.map((d: any) => d.id);
    const permisosEnBd = await prisma.defectoEtapa.findMany({
      where: {
        departamentoId: deptoMontadoId,
        defectoId: { in: idsDevueltos },
        permitido: true,
      },
    });
    expect(permisosEnBd.length).toBe(idsDevueltos.length);
  });

  it("Escenario 2: Sincronización de defectos no borra el catálogo local si la respuesta o página intermedia es inválida", async () => {
    FakeIndexedDBEngine.resetAll();
    idbDatabase.closeConnection();
    await idbDatabase.getDb();

    // Sembrar un defecto válido previo en cat_defectos
    const defectoPrevio: DefectoOfflineStore = {
      id: defectoMontado1.id,
      clave: defectoMontado1.clave,
      defecto: defectoMontado1.defecto,
      clasificacion: "MAYOR",
      departamentoId: deptoMontadoId,
      permitidoEnEtapa: true,
    };
    await idbDatabase.put("cat_defectos", defectoPrevio);

    // Simular respuesta corrupta de red durante sincronizarDefectos
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          success: true,
          data: {
            items: [{ id: "corrupto", clave: null, defecto: "" }],
            total: 1,
            page: 1,
            limit: 200,
            totalPages: 1,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as any;

    try {
      const count = await catalogoOfflineService.sincronizarDefectos(deptoMontadoId);
      expect(count).toBe(0);
    } finally {
      globalThis.fetch = origFetch;
    }

    // Verificar que el catálogo previo permanece intacto en IndexedDB
    const conservados = await catalogoOfflineService.getDefectosLocales();
    expect(conservados.length).toBe(1);
    expect(conservados[0]!.clave).toBe(defectoMontado1.clave);
  });

  it("Escenario 3: Descarga inicial y sincronización diferencial de lotes con actualizaciones, inactivaciones y eliminaciones lógicas", async () => {
    const codigoTemp = `LOTEOFF${Date.now().toString().slice(-5)}`;
    const creado = await prisma.produccionLote.create({
      data: {
        listaLote: `26A01-${codigoTemp}`,
        lista: "26A01",
        lote: codigoTemp,
        idProducto: "PROD-OFF-01",
        modelo: "4D22RS",
        cantidad: 24,
        cliente: "CLIENTE OFFLINE TEST",
        horma: "94 EE",
        estado: "ACTIVO",
      },
    });

    try {
      const marcaAntesDeUpdate = new Date(Date.now() - 5000);

      // 1. Carga diferencial tras creación: debe venir activo = true
      const sync1 = await api(
        "GET",
        `/lotes/catalogo-offline?desde=${encodeURIComponent(marcaAntesDeUpdate.toISOString())}&limit=500`,
        {
          token: juanito.token,
          terminalCred: terminalMontado.credencial,
        },
      );
      expect(sync1.status).toBe(200);
      const itemActivo = sync1.json.data.items.find((i: any) => i.id === creado.id);
      expect(itemActivo).toBeDefined();
      expect(itemActivo.activo).toBe(true);

      // 2. Inactivar / eliminar lógicamente el lote
      await prisma.produccionLote.update({
        where: { id: creado.id },
        data: { estado: "INACTIVO", eliminadoEn: new Date() },
      });

      const sync2 = await api(
        "GET",
        `/lotes/catalogo-offline?desde=${encodeURIComponent(marcaAntesDeUpdate.toISOString())}&limit=500`,
        {
          token: juanito.token,
          terminalCred: terminalMontado.credencial,
        },
      );
      expect(sync2.status).toBe(200);
      const itemInactivo = sync2.json.data.items.find((i: any) => i.id === creado.id);
      expect(itemInactivo).toBeDefined();
      expect(itemInactivo.activo).toBe(false);
    } finally {
      await prisma.produccionLote.delete({ where: { id: creado.id } }).catch(() => undefined);
    }
  });

  it("Escenario 4: Modificaciones concurrentes durante la descarga multipágina de lotes no se pierden", async () => {
    const page1 = await api("GET", "/lotes/catalogo-offline?limit=5&cursor=0", {
      token: juanito.token,
      terminalCred: terminalMontado.credencial,
    });
    expect(page1.status).toBe(200);
    const inicioSyncWatermark = page1.json.data.servidorTimestamp as string;
    expect(inicioSyncWatermark).toBeDefined();

    // Mientras se leería la página 2, se modifica un lote que ya estaba en la página 1
    const loteEnPagina1 = page1.json.data.items[0];
    expect(loteEnPagina1).toBeDefined();

    await prisma.produccionLote.update({
      where: { id: loteEnPagina1.id },
      data: { fechaActualizacion: new Date() },
    });

    // En la siguiente corrida diferencial usando el watermark de inicio (con margen de seguridad de 2s),
    // el lote modificado durante la lectura multipágina aparece garantizadamente:
    const nextDiff = await api(
      "GET",
      `/lotes/catalogo-offline?desde=${encodeURIComponent(inicioSyncWatermark)}&limit=500`,
      {
        token: juanito.token,
        terminalCred: terminalMontado.credencial,
      },
    );
    expect(nextDiff.status).toBe(200);
    const recuperado = nextDiff.json.data.items.some((i: any) => i.id === loteEnPagina1.id);
    expect(recuperado).toBe(true);
  });

  it("Escenario 5: Migración de versión de IndexedDB v1 -> v2 sin perder datos existentes en la cola ni catálogos", async () => {
    FakeIndexedDBEngine.resetAll();
    idbDatabase.closeConnection();

    // 1. Abrir la base simulando versión 1 y poblar `cola_inspecciones` y `cat_lotes`
    await new Promise<void>((resolve, reject) => {
      const req = FakeIndexedDBEngine.open(IDB_NAME, 1);
      req.onupgradeneeded = (ev: any) => {
        const db = ev.target.result;
        db.createObjectStore("sesion_offline", { keyPath: "id" });
        db.createObjectStore("terminal_profile", { keyPath: "id" });
        db.createObjectStore("cat_defectos", { keyPath: "id" });
        db.createObjectStore("cat_lotes", { keyPath: "lote" });
        db.createObjectStore("cola_inspecciones", { keyPath: "idLocalCliente" });
        db.createObjectStore("contingencias_inspecciones", { keyPath: "idLocalCliente" });
        db.createObjectStore("meta_sincronizacion", { keyPath: "clave" });
      };
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(["cola_inspecciones", "cat_lotes"], "readwrite");
        tx.objectStore("cola_inspecciones").put({
          idLocalCliente: "cap-v1-preservada-001",
          inspectorId: juanito.id,
          estado: "PENDIENTE",
          fechaCapturaDispositivo: new Date().toISOString(),
        });
        tx.objectStore("cat_lotes").put({
          lote: lotePrueba.lote,
          id: lotePrueba.id,
          modelo: lotePrueba.modelo,
          cantidad: lotePrueba.cantidad,
        });
        tx.oncomplete = () => resolve();
      };
      req.onerror = () => reject(req.error);
    });

    // 2. Ahora abrir con `idbDatabase.getDb()` que actualiza a IDB_VERSION = 2
    const dbV2 = await idbDatabase.getDb();
    expect(dbV2).not.toBeNull();
    expect(IDB_VERSION).toBe(2);
    expect(dbV2!.objectStoreNames.contains("cat_inspectores")).toBe(true);

    // 3. Confirmar que los registros de v1 siguen intactos tras la migración a v2
    const capturaDeV1 = await idbDatabase.get<any>("cola_inspecciones", "cap-v1-preservada-001");
    expect(capturaDeV1).not.toBeNull();
    expect(capturaDeV1.idLocalCliente).toBe("cap-v1-preservada-001");

    const loteDeV1 = await idbDatabase.get<any>("cat_lotes", lotePrueba.lote);
    expect(loteDeV1).not.toBeNull();
    expect(loteDeV1.modelo).toBe(lotePrueba.modelo);
  });

  // =========================================================================
  // ESCENARIOS 6 A 14 — FASE B: AUTENTICACIÓN MULTIUSUARIO OFFLINE (48 HORAS)
  // =========================================================================

  it("Escenario 6: Precarga del catálogo de inspectores activos autorizados con verificador PBKDF2, salt aleatorio único y token de 48h", async () => {
    const res = await api("GET", "/auth/inspectores-offline", {
      terminalCred: terminalMontado.credencial,
    });
    expect(res.status).toBe(200);
    expect(res.json.data.vigenciaSegundos).toBe(172800); // 48 horas

    const inspectores: any[] = res.json.data.inspectores;
    expect(Array.isArray(inspectores)).toBe(true);

    const itemJuanito = inspectores.find((i) => i.usuario === juanito.usuario);
    const itemJose = inspectores.find((i) => i.usuario === jose.usuario);
    const itemCoord = inspectores.find((i) => i.usuario === coordUser.usuario);

    expect(itemJuanito).toBeDefined();
    expect(itemJose).toBeDefined();
    // El coordinador no tiene rol INSPECTOR: no debe estar en el catálogo de captura offline
    expect(itemCoord).toBeUndefined();

    // Salt aleatorio único de 16 bytes (32 chars hex) y distinto entre usuarios
    expect(itemJuanito.saltOffline).toMatch(/^[0-9a-f]{32}$/);
    expect(itemJose.saltOffline).toMatch(/^[0-9a-f]{32}$/);
    expect(itemJuanito.saltOffline).not.toBe(itemJose.saltOffline);

    // Nunca expone passwordHash ni secretos en la respuesta
    expect((itemJuanito as any).passwordHash).toBeUndefined();
    expect((itemJuanito as any).password).toBeUndefined();

    // Poblar IndexedDB local con el catálogo real devuelto por el servidor y el perfil de la terminal
    FakeIndexedDBEngine.resetAll();
    idbDatabase.closeConnection();
    await idbDatabase.getDb();

    await idbDatabase.put<TerminalProfileStore>("terminal_profile", {
      id: "local",
      terminalId: terminalMontado.id,
      nombre: terminalMontado.nombre,
      departamentoId: deptoMontadoId,
      departamentoCodigo: "MONTADO",
      departamentoNombre: "MONTADO",
      guardadoEn: new Date().toISOString(),
    });

    for (const item of inspectores) {
      await idbDatabase.put<InspectorOfflineStore>("cat_inspectores", {
        ...item,
        intentosFallidos: 0,
        bloqueadoHasta: null,
        actualizadoEn: new Date().toISOString(),
      });
    }

    await idbDatabase.put<LoteOfflineStore>("cat_lotes", {
      lote: lotePrueba.lote,
      id: lotePrueba.id,
      lista: lotePrueba.lista,
      idProducto: "PROD-1",
      modelo: lotePrueba.modelo,
      cantidad: lotePrueba.cantidad,
      horma: "94 EE",
      cliente: "MBC",
      actualizadoEn: new Date().toISOString(),
    });

    await idbDatabase.putBatch<DefectoOfflineStore>("cat_defectos", [
      {
        id: defectoMontado1.id,
        clave: defectoMontado1.clave,
        defecto: defectoMontado1.defecto,
        clasificacion: "MAYOR",
        departamentoId: deptoMontadoId,
        permitidoEnEtapa: true,
      },
      {
        id: defectoMontado2.id,
        clave: defectoMontado2.clave,
        defecto: defectoMontado2.defecto,
        clasificacion: "MENOR",
        departamentoId: deptoMontadoId,
        permitidoEnEtapa: true,
      },
    ]);

    const locales = await catalogoOfflineService.getInspectoresLocales();
    expect(locales.some((i) => i.nombre === juanito.nombre)).toBe(true);
    expect(locales.some((i) => i.nombre === jose.nombre)).toBe(true);
  });

  it("Escenario 7: Login offline de un inspector precargado que nunca había iniciado sesión personalmente en esa PC", async () => {
    // José nunca inició sesión online en este navegador, pero está en `cat_inspectores` de la terminal.
    // Puede autenticarse offline seleccionando su nombre completo o su usuario:
    const loginJose = await offlineAuthClientService.authenticateOffline({
      usuario: jose.nombre, // Selección por nombre completo
      password: jose.password,
    });

    expect(loginJose.user.id).toBe(jose.id);
    expect(loginJose.user.usuario).toBe(jose.usuario);
    expect(loginJose.user.nombre).toBe(jose.nombre);
    expect(loginJose.sesionOffline.inspectorId).toBe(jose.id);
    expect(loginJose.sesionOffline.vigenciaSegundos).toBe(172800);
  });

  it("Escenario 8: Rechazo de login offline con contraseña incorrecta y bloqueo tras intentos fallidos", async () => {
    // 1. Contraseña incorrecta incrementa intentosFallidos y lanza INVALID_PASSWORD
    await expect(
      offlineAuthClientService.authenticateOffline({
        usuario: juanito.usuario,
        password: "PasswordIncorrecta1",
      }),
    ).rejects.toThrow("Contraseña incorrecta");

    // 2. Alcanzar los 5 intentos fallidos bloquea temporalmente la cuenta en la terminal (RATE_LIMITED)
    for (let i = 2; i <= 5; i++) {
      await expect(
        offlineAuthClientService.authenticateOffline({
          usuario: juanito.usuario,
          password: `PasswordIncorrecta${i}`,
        }),
      ).rejects.toThrow();
    }

    // Incluso con la contraseña correcta ahora debe rechazar mientras dure el bloqueo
    await expect(
      offlineAuthClientService.authenticateOffline({
        usuario: juanito.usuario,
        password: juanito.password,
      }),
    ).rejects.toThrow("bloqueada temporalmente");

    // Avanzar el tiempo simulado más allá de los 5 minutos de bloqueo restaura el acceso con contraseña correcta
    const futuroPostBloqueo = Date.now() + 6 * 60 * 1000;
    const loginExitoso = await offlineAuthClientService.authenticateOffline({
      usuario: juanito.usuario,
      password: juanito.password,
      nowMs: futuroPostBloqueo,
    });
    expect(loginExitoso.user.id).toBe(juanito.id);

    // Reiniciar el reloj monotónico al presente para los siguientes escenarios
    await idbDatabase.put("meta_sincronizacion", {
      clave: "max_observed_timestamp_ms",
      valor: Date.now(),
      actualizadoEn: new Date().toISOString(),
    });
  });

  it("Escenario 9: Rechazo de login offline para un usuario inactivo o sin permiso de captura", async () => {
    // 1. Usuario administrativo/coordinador no precargado en cat_inspectores
    await expect(
      offlineAuthClientService.authenticateOffline({
        usuario: coordUser.usuario,
        password: coordUser.password,
      }),
    ).rejects.toThrow("no está precargado en esta terminal");

    // 2. Si un registro en cat_inspectores se marca inactivo o sin permiso defectos.capturar, se rechaza
    const inspJuanito = (await idbDatabase.get<InspectorOfflineStore>("cat_inspectores", juanito.id))!;
    await idbDatabase.put<InspectorOfflineStore>("cat_inspectores", {
      ...inspJuanito,
      activo: false,
    });

    await expect(
      offlineAuthClientService.authenticateOffline({
        usuario: juanito.usuario,
        password: juanito.password,
      }),
    ).rejects.toThrow("no está activo o no cuenta con permisos de captura");

    // Restaurar activo = true
    await idbDatabase.put<InspectorOfflineStore>("cat_inspectores", {
      ...inspJuanito,
      activo: true,
    });
  });

  it("Escenario 10: Cambio de contraseña en el servidor actualiza el verificador y el salt aleatorio e invalida la contraseña anterior tras sincronizar", async () => {
    const antes = (await idbDatabase.get<InspectorOfflineStore>("cat_inspectores", juanito.id))!;
    const nuevaPassword = "NuevaJuanitoPass2026#";

    // Cambiar contraseña en MySQL
    await prisma.usuario.update({
      where: { id: juanito.id },
      data: { passwordHash: securityService.hashPassword(nuevaPassword) },
    });

    try {
      const resCatalog = await api("GET", "/auth/inspectores-offline", {
        terminalCred: terminalMontado.credencial,
      });
      const actualizado = resCatalog.json.data.inspectores.find(
        (i: any) => i.inspectorId === juanito.id,
      );
      expect(actualizado).toBeDefined();
      // El salt aleatorio y el verificador PBKDF2 deben haber rotado
      expect(actualizado.saltOffline).not.toBe(antes.saltOffline);
      expect(actualizado.verifierOffline).not.toBe(antes.verifierOffline);

      await idbDatabase.put<InspectorOfflineStore>("cat_inspectores", {
        ...actualizado,
        intentosFallidos: 0,
        bloqueadoHasta: null,
        actualizadoEn: new Date().toISOString(),
      });

      // La contraseña vieja debe fallar
      await expect(
        offlineAuthClientService.authenticateOffline({
          usuario: juanito.usuario,
          password: juanito.password,
        }),
      ).rejects.toThrow("Contraseña incorrecta");

      // La contraseña nueva debe funcionar
      const ok = await offlineAuthClientService.authenticateOffline({
        usuario: juanito.usuario,
        password: nuevaPassword,
      });
      expect(ok.user.id).toBe(juanito.id);
    } finally {
      // Restaurar contraseña original de Juanito y actualizar su registro local
      await prisma.usuario.update({
        where: { id: juanito.id },
        data: { passwordHash: securityService.hashPassword(juanito.password) },
      });
      const resRestaurado = await api("GET", "/auth/inspectores-offline", {
        terminalCred: terminalMontado.credencial,
      });
      const itemRestaurado = resRestaurado.json.data.inspectores.find(
        (i: any) => i.inspectorId === juanito.id,
      );
      await idbDatabase.put<InspectorOfflineStore>("cat_inspectores", {
        ...itemRestaurado,
        intentosFallidos: 0,
        bloqueadoHasta: null,
        actualizadoEn: new Date().toISOString(),
      });
    }
  });

  it("Escenario 11: Desactivación de un inspector en el servidor elimina su acceso offline tras sincronizar cat_inspectores", async () => {
    await prisma.usuario.update({
      where: { id: jose.id },
      data: { estado: "INACTIVO" },
    });

    try {
      const resCatalog = await api("GET", "/auth/inspectores-offline", {
        terminalCred: terminalMontado.credencial,
      });
      expect(resCatalog.status).toBe(200);
      const sigueEnCatalogo = resCatalog.json.data.inspectores.some(
        (i: any) => i.inspectorId === jose.id,
      );
      expect(sigueEnCatalogo).toBe(false);
    } finally {
      await prisma.usuario.update({
        where: { id: jose.id },
        data: { estado: "ACTIVO" },
      });
    }
  });

  it("Escenario 12: Cambio de usuario en la misma PC (Juanito -> logout -> José -> logout -> Juanito) sin borrar catálogos ni cola pendiente", async () => {
    // Limpiar cola previa
    await idbDatabase.clear("cola_inspecciones");

    // 1. Juanito inicia sesión offline y captura una inspección
    await offlineAuthClientService.authenticateOffline({
      usuario: juanito.nombre,
      password: juanito.password,
    });

    const capJuanito = await inspeccionesOfflineService.encolarCaptura({
      inspector: { id: juanito.id, usuario: juanito.usuario, nombre: juanito.nombre },
      payload: {
        lote: lotePrueba.lote,
        lineaTexto: "L1",
        detalles: [
          {
            defectoId: defectoMontado1.id,
            defDeptoId: deptoMontadoId,
            paresDefectuosos: 2,
          },
        ],
      },
    });
    expect(capJuanito.inspectorId).toBe(juanito.id);

    // 2. Juanito cierra sesión (solo se elimina `sesion_offline` con id 'activa')
    await idbDatabase.delete("sesion_offline", "activa");
    expect(await idbDatabase.get("sesion_offline", "activa")).toBeNull();

    // Los catálogos y la captura pendiente de Juanito siguen intactos
    expect((await catalogoOfflineService.getInspectoresLocales()).length).toBeGreaterThanOrEqual(2);
    expect((await inspeccionesOfflineService.obtenerResumenCola()).pendientes).toBe(1);

    // 3. José inicia sesión offline en la misma PC y captura otra inspección
    const sesionJose = await offlineAuthClientService.authenticateOffline({
      usuario: jose.nombre,
      password: jose.password,
    });
    expect(sesionJose.user.id).toBe(jose.id);

    const capJose = await inspeccionesOfflineService.encolarCaptura({
      inspector: { id: jose.id, usuario: jose.usuario, nombre: jose.nombre },
      payload: {
        lote: lotePrueba.lote,
        lineaTexto: "L2",
        detalles: [
          {
            defectoId: defectoMontado2.id,
            defDeptoId: deptoMontadoId,
            paresDefectuosos: 3,
          },
        ],
      },
    });
    expect(capJose.inspectorId).toBe(jose.id);

    // 4. José cierra sesión y Juanito vuelve a entrar
    await idbDatabase.delete("sesion_offline", "activa");
    const reingresoJuanito = await offlineAuthClientService.authenticateOffline({
      usuario: juanito.nombre,
      password: juanito.password,
    });
    expect(reingresoJuanito.user.id).toBe(juanito.id);

    const resumenCola = await inspeccionesOfflineService.obtenerResumenCola();
    expect(resumenCola.pendientes).toBe(2);
  });

  it("Escenario 13: Capturas realizadas por Juanito y José offline conservan cada una su inspectorId y offlineToken reales", async () => {
    const resumen = await inspeccionesOfflineService.obtenerResumenCola();
    const itemJuanito = resumen.items.find((i) => i.inspectorId === juanito.id)!;
    const itemJose = resumen.items.find((i) => i.inspectorId === jose.id)!;

    expect(itemJuanito).toBeDefined();
    expect(itemJose).toBeDefined();
    expect(itemJuanito.offlineToken).not.toBe(itemJose.offlineToken);

    const decodedJuanito = offlineAuthService.verifyOfflineToken(itemJuanito.offlineToken);
    const decodedJose = offlineAuthService.verifyOfflineToken(itemJose.offlineToken);

    expect(decodedJuanito.sub).toBe(juanito.id);
    expect(decodedJose.sub).toBe(jose.id);
    expect(decodedJuanito.terminalId).toBe(terminalMontado.id);
    expect(decodedJose.terminalId).toBe(terminalMontado.id);
  });

  it("Escenario 14: Vigencia de 48 horas (172,800 segundos): bloqueo de nuevas capturas tras el vencimiento, pero conservación de capturas previas", async () => {
    const resumenAntes = await inspeccionesOfflineService.obtenerResumenCola();
    expect(resumenAntes.pendientes).toBe(2);

    // Simular que han transcurrido 49 horas (> 172,800s) desde la emisión del token
    const ahoraMas49HorasMs = Date.now() + 49 * 3600 * 1000;

    await expect(
      inspeccionesOfflineService.encolarCaptura({
        inspector: { id: juanito.id, usuario: juanito.usuario, nombre: juanito.nombre },
        nowMs: ahoraMas49HorasMs,
        payload: {
          lote: lotePrueba.lote,
          detalles: [
            {
              defectoId: defectoMontado1.id,
              defDeptoId: deptoMontadoId,
              paresDefectuosos: 1,
            },
          ],
        },
      }),
    ).rejects.toThrow("48 horas ha vencido");

    // Las 2 capturas guardadas legítimamente antes del vencimiento permanecen intactas en la cola
    const resumenDespues = await inspeccionesOfflineService.obtenerResumenCola();
    expect(resumenDespues.pendientes).toBe(2);

    // Restaurar reloj monotónico al presente
    await idbDatabase.put("meta_sincronizacion", {
      clave: "max_observed_timestamp_ms",
      valor: Date.now(),
      actualizadoEn: new Date().toISOString(),
    });
  });

  // =========================================================================
  // ESCENARIOS 15 A 24 — FASES C Y D: COLA PERSISTENTE, IDEMPOTENCIA Y LEGACY TXT
  // =========================================================================

  it("Escenario 15: Sincronización exitosa de la cola cuando vuelve la conexión, incluso si otro usuario está logueado o nadie ha iniciado sesión", async () => {
    // Cerrar cualquier sesión activa en el navegador: nadie está logueado, pero la terminal tiene red
    await idbDatabase.delete("sesion_offline", "activa");

    const resumenCola = await inspeccionesOfflineService.obtenerResumenCola();
    expect(resumenCola.items.length).toBe(2);

    // Enviar el lote al endpoint real `POST /api/v1/inspecciones/sync` solo con `x-terminal-credential`
    const syncRes = await api("POST", "/inspecciones/sync", {
      terminalCred: terminalMontado.credencial,
      body: {
        items: resumenCola.items.map((c) => ({
          idLocalCliente: c.idLocalCliente,
          inspectorId: c.inspectorId,
          offlineToken: c.offlineToken,
          fechaCapturaDispositivo: c.fechaCapturaDispositivo,
          esContingencia: c.esContingencia,
          motivoContingencia: c.motivoContingencia,
          payload: c.payload,
        })),
      },
    });

    expect(syncRes.status).toBe(200);
    expect(syncRes.json.data.resumen.total).toBe(2);
    expect(syncRes.json.data.resumen.sincronizadas).toBe(2);

    // Verificar en MySQL que cada inspección quedó registrada con su inspector real (Juanito y José)
    for (const r of syncRes.json.data.resultados) {
      expect(r.estado).toBe("SINCRONIZADA");
      const cab = await prisma.inspeccionCabecera.findUniqueOrThrow({
        where: { id: r.inspeccionId },
      });
      expect(cab.inspectorId).toBe(r.inspectorId);
      expect(cab.claveIdempotencia).toBe(r.idLocalCliente);
    }

    // Por defecto (LEGACY_TXT_EXPORT_ENABLED !== "true"), MySQL es el destino único y NO se escribe en TXT
    expect(inspeccionesLegacyService.isEnabled()).toBe(false);
    const archivoMontado = join(legacyTempDir, "Defectos_Montado.txt");
    expect(existsSync(archivoMontado)).toBe(false);
  });

  it("Escenario 16: Reintento idempotente cuando el servidor guardó en MySQL pero la respuesta HTTP se perdió", async () => {
    const resumenCola = await inspeccionesOfflineService.obtenerResumenCola();
    const itemReintento = resumenCola.items[0]!;

    // Reenviar exactamente la misma captura (como si el cliente nunca hubiera recibido el 200 OK anterior)
    const retryRes = await api("POST", "/inspecciones/sync", {
      terminalCred: terminalMontado.credencial,
      body: {
        items: [
          {
            idLocalCliente: itemReintento.idLocalCliente,
            inspectorId: itemReintento.inspectorId,
            offlineToken: itemReintento.offlineToken,
            fechaCapturaDispositivo: itemReintento.fechaCapturaDispositivo,
            esContingencia: itemReintento.esContingencia,
            motivoContingencia: itemReintento.motivoContingencia,
            payload: itemReintento.payload,
          },
        ],
      },
    });

    expect(retryRes.status).toBe(200);
    const resultado = retryRes.json.data.resultados[0];
    expect(resultado.estado).toBe("REPETIDA_IDEMPOTENTE");

    // Verificar que NO se duplicó ni cabecera ni detalle en MySQL
    const conteoEnBd = await prisma.inspeccionCabecera.count({
      where: {
        inspectorId: itemReintento.inspectorId,
        claveIdempotencia: itemReintento.idLocalCliente,
      },
    });
    expect(conteoEnBd).toBe(1);

    const cab = await prisma.inspeccionCabecera.findUniqueOrThrow({
      where: {
        unique_inspector_clave_idempotencia: {
          inspectorId: itemReintento.inspectorId,
          claveIdempotencia: itemReintento.idLocalCliente,
        },
      },
      include: { detalles: true },
    });
    expect(cab.detalles.length).toBe(itemReintento.payload.detalles.length);
  });

  it("Escenario 17: Rechazo por conflicto (409) cuando se reutiliza la misma clave de idempotencia con un payload distinto", async () => {
    const resumenCola = await inspeccionesOfflineService.obtenerResumenCola();
    const itemExistente = resumenCola.items[0]!;

    // Enviar la misma `idLocalCliente` pero alterando la cantidad de pares defectuosos (de 2 a 9)
    const conflictRes = await api("POST", "/inspecciones/sync", {
      terminalCred: terminalMontado.credencial,
      body: {
        items: [
          {
            idLocalCliente: itemExistente.idLocalCliente,
            inspectorId: itemExistente.inspectorId,
            offlineToken: itemExistente.offlineToken,
            fechaCapturaDispositivo: itemExistente.fechaCapturaDispositivo,
            payload: {
              ...itemExistente.payload,
              detalles: [
                {
                  defectoId: defectoMontado1.id,
                  defDeptoId: deptoMontadoId,
                  paresDefectuosos: 9,
                },
              ],
            },
          },
        ],
      },
    });

    expect(conflictRes.status).toBe(200);
    const r = conflictRes.json.data.resultados[0];
    expect(r.estado).toBe("CONFLICTO_IDEMPOTENCIA");
    expect(r.codigoHttp).toBe(409);

    // También probar en el endpoint unitario `POST /api/v1/inspecciones` con encabezado Idempotency-Key
    const directConflict = await api("POST", "/inspecciones", {
      token: juanito.token,
      terminalCred: terminalMontado.credencial,
      headers: { "Idempotency-Key": itemExistente.idLocalCliente },
      body: {
        lote: lotePrueba.lote,
        detalles: [
          {
            defectoId: defectoMontado1.id,
            defDeptoId: deptoMontadoId,
            paresDefectuosos: 9,
          },
        ],
      },
    });
    expect(directConflict.status).toBe(409);
  });

  it("Escenario 18: Sincronización de una captura realizada con token válido que venció antes de recuperar la red", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    // Token emitido hace 72 horas y expirado hace 24 horas (ventana de 48h):
    const iatPasado = nowSec - 72 * 3600;
    const tokenVencido = offlineAuthService.generateOfflineToken({
      usuarioId: juanito.id,
      usuario: juanito.usuario,
      nombre: juanito.nombre,
      terminalId: terminalMontado.id,
      terminalNombre: terminalMontado.nombre,
      departamentoId: deptoMontadoId,
      issuedAtSec: iatPasado,
    });

    // La captura ocurrió hace 50 horas (DENTRO de la ventana válida [iatPasado, expPasado])
    const fechaCapturaValidaIso = new Date((iatPasado + 22 * 3600) * 1000).toISOString();
    const idLocal = `cap-post-exp-${Date.now()}`;

    const syncRes = await api("POST", "/inspecciones/sync", {
      terminalCred: terminalMontado.credencial,
      body: {
        items: [
          {
            idLocalCliente: idLocal,
            inspectorId: juanito.id,
            offlineToken: tokenVencido.token,
            fechaCapturaDispositivo: fechaCapturaValidaIso,
            payload: {
              lote: lotePrueba.lote,
              detalles: [
                {
                  defectoId: defectoMontado1.id,
                  defDeptoId: deptoMontadoId,
                  paresDefectuosos: 1,
                },
              ],
            },
          },
        ],
      },
    });

    expect(syncRes.status).toBe(200);
    const r = syncRes.json.data.resultados[0];
    expect(r.estado).toBe("SINCRONIZADA");
    expect(r.legacySincronizado).toBe(true);

    // En cambio, si la fecha de captura fue POSTERIOR al vencimiento de las 48h, el servidor la rechaza:
    const fechaCapturaFueraDeVentanaIso = new Date((tokenVencido.expiraEn + 3600) * 1000).toISOString();
    const syncRechazada = await api("POST", "/inspecciones/sync", {
      terminalCred: terminalMontado.credencial,
      body: {
        items: [
          {
            idLocalCliente: `cap-fuera-ventana-${Date.now()}`,
            inspectorId: juanito.id,
            offlineToken: tokenVencido.token,
            fechaCapturaDispositivo: fechaCapturaFueraDeVentanaIso,
            payload: {
              lote: lotePrueba.lote,
              detalles: [
                {
                  defectoId: defectoMontado1.id,
                  defDeptoId: deptoMontadoId,
                  paresDefectuosos: 1,
                },
              ],
            },
          },
        ],
      },
    });

    expect(syncRechazada.json.data.resultados[0].estado).toBe("RECHAZADA");
    expect(syncRechazada.json.data.resultados[0].codigoHttp).toBe(401);
  });

  it("Escenario 19: Sincronización de una captura realizada por un inspector que fue desactivado antes de recuperar la red (no se pierde, queda en revisión)", async () => {
    const tokenJose = offlineAuthService.generateOfflineToken({
      usuarioId: jose.id,
      usuario: jose.usuario,
      nombre: jose.nombre,
      terminalId: terminalMontado.id,
      terminalNombre: terminalMontado.nombre,
      departamentoId: deptoMontadoId,
    });

    // Desactivar a José en MySQL mientras la captura estaba en la cola offline
    await prisma.usuario.update({
      where: { id: jose.id },
      data: { estado: "INACTIVO" },
    });

    try {
      const idLocal = `cap-jose-inactivo-${Date.now()}`;
      const syncRes = await api("POST", "/inspecciones/sync", {
        terminalCred: terminalMontado.credencial,
        body: {
          items: [
            {
              idLocalCliente: idLocal,
              inspectorId: jose.id,
              offlineToken: tokenJose.token,
              fechaCapturaDispositivo: new Date().toISOString(),
              payload: {
                lote: lotePrueba.lote,
                detalles: [
                  {
                    defectoId: defectoMontado2.id,
                    defDeptoId: deptoMontadoId,
                    paresDefectuosos: 2,
                  },
                ],
              },
            },
          ],
        },
      });

      expect(syncRes.status).toBe(200);
      const r = syncRes.json.data.resultados[0];
      expect(r.estado).toBe("SINCRONIZADA");
      expect(r.requiereRevision).toBe(true);
      expect(r.motivoRevision).toContain("desactivado");

      // Verificar que en MySQL se guardó con estado PENDIENTE para revisión de auditoría y José sigue INACTIVO
      const cab = await prisma.inspeccionCabecera.findUniqueOrThrow({
        where: { id: r.inspeccionId },
      });
      expect(cab.estado).toBe("PENDIENTE");
      expect(cab.inspectorId).toBe(jose.id);

      const joseDb = await prisma.usuario.findUniqueOrThrow({ where: { id: jose.id } });
      expect(joseDb.estado).toBe("INACTIVO");
    } finally {
      await prisma.usuario.update({
        where: { id: jose.id },
        data: { estado: "ACTIVO" },
      });
    }
  });

  it("Escenario 20: Rechazo de un offlineToken manipulado o firmado con otro secreto", async () => {
    const valido = offlineAuthService.generateOfflineToken({
      usuarioId: juanito.id,
      usuario: juanito.usuario,
      nombre: juanito.nombre,
      terminalId: terminalMontado.id,
      terminalNombre: terminalMontado.nombre,
      departamentoId: deptoMontadoId,
    });

    const parts = valido.token.split(".");
    const tokenManipulado = `${parts[0]}.${parts[1]}.FIRMA_MANIPULADA_123`;

    const res = await api("POST", "/inspecciones/sync", {
      terminalCred: terminalMontado.credencial,
      body: {
        items: [
          {
            idLocalCliente: `cap-manipulada-${Date.now()}`,
            inspectorId: juanito.id,
            offlineToken: tokenManipulado,
            fechaCapturaDispositivo: new Date().toISOString(),
            payload: {
              lote: lotePrueba.lote,
              detalles: [
                {
                  defectoId: defectoMontado1.id,
                  defDeptoId: deptoMontadoId,
                  paresDefectuosos: 1,
                },
              ],
            },
          },
        ],
      },
    });

    expect(res.status).toBe(200);
    expect(res.json.data.resultados[0].estado).toBe("RECHAZADA");
    expect(res.json.data.resultados[0].codigoHttp).toBe(401);
  });

  it("Escenario 21: Un error en la exportación legacy opcional nunca invalida una captura ya confirmada en MySQL ni fuerza reintentos duplicados", async () => {
    const tokenJuanito = offlineAuthService.generateOfflineToken({
      usuarioId: juanito.id,
      usuario: juanito.usuario,
      nombre: juanito.nombre,
      terminalId: terminalMontado.id,
      terminalNombre: terminalMontado.nombre,
      departamentoId: deptoMontadoId,
    });

    const idLocal = `cap-legacy-recovery-${Date.now()}`;
    const archivoMontado = join(legacyTempDir, "Defectos_Montado.txt");

    // Habilitar temporalmente la exportación legacy opcional y simular 1 fallo de disco
    inspeccionesLegacyService.setEnabled(true);
    inspeccionesLegacyService.setSimulateFailureCount(1);

    try {
      const intento1 = await api("POST", "/inspecciones/sync", {
        terminalCred: terminalMontado.credencial,
        body: {
          items: [
            {
              idLocalCliente: idLocal,
              inspectorId: juanito.id,
              offlineToken: tokenJuanito.token,
              fechaCapturaDispositivo: new Date().toISOString(),
              payload: {
                lote: lotePrueba.lote,
                detalles: [
                  {
                    defectoId: defectoMontado1.id,
                    defDeptoId: deptoMontadoId,
                    paresDefectuosos: 4,
                  },
                ],
              },
            },
          ],
        },
      });

      expect(intento1.status).toBe(200);
      const r1 = intento1.json.data.resultados[0];
      // MySQL ya persistió la cabecera y es el destino principal: devuelve SINCRONIZADA (201) aunque el TXT opcional haya fallado
      expect(r1.estado).toBe("SINCRONIZADA");
      expect(r1.codigoHttp).toBe(201);
      expect(r1.legacySincronizado).toBe(false);
      expect(r1.inspeccionId).toBeDefined();

      // Si el cliente vuelve a enviar la misma captura (p. ej. por caída de red previa a recibir la respuesta),
      // MySQL responde REPETIDA_IDEMPOTENTE sin duplicar filas y la exportación opcional puede escribir la línea si está habilitada
      const intento2 = await api("POST", "/inspecciones/sync", {
        terminalCred: terminalMontado.credencial,
        body: {
          items: [
            {
              idLocalCliente: idLocal,
              inspectorId: juanito.id,
              offlineToken: tokenJuanito.token,
              fechaCapturaDispositivo: new Date().toISOString(),
              payload: {
                lote: lotePrueba.lote,
                detalles: [
                  {
                    defectoId: defectoMontado1.id,
                    defDeptoId: deptoMontadoId,
                    paresDefectuosos: 4,
                  },
                ],
              },
            },
          ],
        },
      });

      expect(intento2.status).toBe(200);
      const r2 = intento2.json.data.resultados[0];
      expect(r2.estado).toBe("REPETIDA_IDEMPOTENTE");
      expect(r2.legacySincronizado).toBe(true);

      const conteoMysql = await prisma.inspeccionCabecera.count({
        where: { inspectorId: juanito.id, claveIdempotencia: idLocal },
      });
      expect(conteoMysql).toBe(1);
      expect(existsSync(archivoMontado)).toBe(true);
    } finally {
      inspeccionesLegacyService.setEnabled(false);
    }
  });

  it("Escenario 22: Escritura legacy correcta para el caso especial de AVÍOS (sin columna Linea en los datos cuando se habilita exportación opcional)", async () => {
    const tokenAvios = offlineAuthService.generateOfflineToken({
      usuarioId: juanito.id,
      usuario: juanito.usuario,
      nombre: juanito.nombre,
      terminalId: terminalAvios.id,
      terminalNombre: terminalAvios.nombre,
      departamentoId: deptoAviosId,
    });

    inspeccionesLegacyService.setEnabled(true);
    try {
      const idLocal = `cap-avios-format-${Date.now()}`;
      const res = await api("POST", "/inspecciones/sync", {
        terminalCred: terminalAvios.credencial,
        body: {
          items: [
            {
              idLocalCliente: idLocal,
              inspectorId: juanito.id,
              offlineToken: tokenAvios.token,
              fechaCapturaDispositivo: new Date().toISOString(),
              payload: {
                lote: lotePrueba.lote,
                lineaTexto: "L1",
                detalles: [
                  {
                    defectoId: defectoAvios1.id,
                    defDeptoId: deptoAviosId,
                    paresDefectuosos: 2,
                  },
                ],
              },
            },
          ],
        },
      });

      expect(res.status).toBe(200);
      expect(res.json.data.resultados[0].estado).toBe("SINCRONIZADA");

      const archivoAvios = join(legacyTempDir, "Defectos_Avios.txt");
      expect(existsSync(archivoAvios)).toBe(true);

      const lineas = readFileSync(archivoAvios, "latin1").trim().split(/\r?\n/);
      expect(lineas.length).toBe(2); // Encabezado + 1 fila de datos

      const colsDatos = lineas[1]!.split("\t");
      // En AVÍOS: Col 0 = No, Col 1 = AVIOS, Col 2 = Fecha, Col 3 = Lista, Col 4 = Lote,
      // Col 5 = Modelo (omite Linea!), Col 6 = Descripcion, Col 7 = DefDepto, Col 8 = Id (clave),
      // Col 9 = Defecto, Col 10 = Prs, Col 11 = Horma, Col 12 = Usuario, Col 13 = "" (tab final)
      expect(colsDatos[1]).toBe("AVIOS");
      expect(colsDatos[3]).toBe(lotePrueba.lista);
      expect(colsDatos[4]).toBe(lotePrueba.lote);
      expect(colsDatos[5]).toBe(lotePrueba.modelo); // Modelo en posición 5 porque no hay Linea
      expect(colsDatos[8]).toBe(String(defectoAvios1.clave));
      expect(colsDatos[10]).toBe("2");
      expect(colsDatos[12]).toBe(juanito.nombre);
    } finally {
      inspeccionesLegacyService.setEnabled(false);
    }
  });

  it("Escenario 23: Protección contra duplicación en el caso especial de ADORNO / 4Q18RS cuando se habilita exportación opcional", async () => {
    const tokenAdorno = offlineAuthService.generateOfflineToken({
      usuarioId: jose.id,
      usuario: jose.usuario,
      nombre: jose.nombre,
      terminalId: terminalAdorno.id,
      terminalNombre: terminalAdorno.nombre,
      departamentoId: deptoAdornoId,
    });

    inspeccionesLegacyService.setEnabled(true);
    try {
      const idLocal = `cap-adorno-indiv-${Date.now()}`;
      const payloadAdorno = {
        idLocalCliente: idLocal,
        inspectorId: jose.id,
        offlineToken: tokenAdorno.token,
        fechaCapturaDispositivo: new Date().toISOString(),
        payload: {
          lote: lotePrueba.lote,
          lineaTexto: "L1",
          detalles: [
            {
              defectoId: defectoAdorno1.id,
              defDeptoId: deptoAdornoId,
              paresDefectuosos: 3,
            },
          ],
        },
      };

      // Enviar 2 veces seguidas la misma captura de ADORNO
      const res1 = await api("POST", "/inspecciones/sync", {
        terminalCred: terminalAdorno.credencial,
        body: { items: [payloadAdorno] },
      });
      const res2 = await api("POST", "/inspecciones/sync", {
        terminalCred: terminalAdorno.credencial,
        body: { items: [payloadAdorno] },
      });

      expect(res1.json.data.resultados[0].estado).toBe("SINCRONIZADA");
      expect(res2.json.data.resultados[0].estado).toBe("REPETIDA_IDEMPOTENTE");

      const archivoAdorno = join(legacyTempDir, "Defectos_Adorno.txt");
      expect(existsSync(archivoAdorno)).toBe(true);
      const lineas = readFileSync(archivoAdorno, "latin1").trim().split(/\r?\n/);
      // Exactamente 1 fila de datos (sin duplicar pares ni mezclar con el modelo dummy semanal 4Q18RS)
      expect(lineas.length).toBe(2);
      expect(lineas[1]).toContain(lotePrueba.lote);
      expect(lineas[1]).toContain(lotePrueba.modelo);
      expect(existsSync(join(legacyTempDir, "Df_Ado.txt"))).toBe(false);
    } finally {
      inspeccionesLegacyService.setEnabled(false);
    }
  });

  it("Escenario 24: Indisponibilidad de IndexedDB o QuotaExceededError sin reportar falsos guardados exitosos", async () => {
    // 1. Simular QuotaExceededError al intentar encolar una captura offline
    FakeIndexedDBEngine.simulateQuotaExceeded = true;
    try {
      await expect(
        inspeccionesOfflineService.encolarCaptura({
          inspector: { id: juanito.id, usuario: juanito.usuario, nombre: juanito.nombre },
          payload: {
            lote: lotePrueba.lote,
            detalles: [
              {
                defectoId: defectoMontado1.id,
                defDeptoId: deptoMontadoId,
                paresDefectuosos: 1,
              },
            ],
          },
        }),
      ).rejects.toThrow("Espacio insuficiente");
    } finally {
      FakeIndexedDBEngine.simulateQuotaExceeded = false;
    }

    // 2. Simular indisponibilidad total de IndexedDB (por ejemplo modo privado restringido)
    const savedIdb = (globalThis as any).indexedDB;
    delete (globalThis as any).indexedDB;
    idbDatabase.closeConnection();

    try {
      expect(idbDatabase.getAvailable()).toBe(false);
      await expect(
        inspeccionesOfflineService.encolarCaptura({
          inspector: { id: juanito.id, usuario: juanito.usuario, nombre: juanito.nombre },
          payload: {
            lote: lotePrueba.lote,
            detalles: [
              {
                defectoId: defectoMontado1.id,
                defDeptoId: deptoMontadoId,
                paresDefectuosos: 1,
              },
            ],
          },
        }),
      ).rejects.toThrow("IndexedDB no está disponible");
    } finally {
      (globalThis as any).indexedDB = savedIdb;
      idbDatabase.closeConnection();
    }
  });

  // =========================================================================
  // ESCENARIOS 25 A 29 — PRUEBAS DE REGRESIÓN DE AUTENTICACIÓN Y TERMINAL
  // =========================================================================

  it("Escenario 25: SUPER_ADMIN sin terminal vinculada puede iniciar sesión, consultar endpoints administrativos y mantener su sesión activa sin cerrar sesión por falta de terminal", async () => {
    terminalStorage.removeCredential();
    authState.setAccessToken(superAdminToken);

    let sessionExpiredCount = 0;
    const onExpired = () => {
      sessionExpiredCount += 1;
    };
    window.addEventListener("auth:session-expired", onExpired);

    try {
      // 1. La sincronización offline en segundo plano NO hace llamadas de terminal cuando no hay credencial vinculada
      await catalogoOfflineService.sincronizarTodoEnBackground();
      const syncResult = await inspeccionesOfflineService.sincronizarCola();
      expect(syncResult.sincronizadas).toBe(0);

      // 2. El SUPER_ADMIN puede consultar `/auth/me` con normalidad y su token en memoria permanece intacto
      const meRes = await httpClient.get<any>("/auth/me");
      expect(meRes.success).toBe(true);
      expect(meRes.data.user.usuario).toBe("admin");
      expect(authState.getAccessToken()).toBe(superAdminToken);
      expect(sessionExpiredCount).toBe(0);
    } finally {
      window.removeEventListener("auth:session-expired", onExpired);
    }
  });

  it("Escenario 26: INSPECTOR con terminal vinculada puede iniciar sesión y precargar todos los datos offline (inspectores, lotes, defectos y sesión offline)", async () => {
    terminalStorage.setCredential(terminalMontado.credencial);
    authState.setAccessToken(juanito.token);

    // 1. Emitir y guardar sesión offline para Juanito
    const sesionEmitida = await catalogoOfflineService.sincronizarSesionOffline();
    expect(sesionEmitida).not.toBeNull();

    const sesionGuardada = await catalogoOfflineService.getSesionOfflineVigente();
    expect(sesionGuardada).not.toBeNull();
    expect(sesionGuardada!.inspectorId).toBe(juanito.id);
    expect(sesionGuardada!.terminalId).toBe(terminalMontado.id);

    // 2. Sincronizar catálogo de inspectores y defectos desde el servidor real usando httpClient
    const numInspectores = await catalogoOfflineService.sincronizarInspectoresOffline();
    expect(numInspectores).toBeGreaterThanOrEqual(2);

    const numDefectos = await catalogoOfflineService.sincronizarDefectos(deptoMontadoId);
    expect(numDefectos).toBeGreaterThan(0);

    // 3. Verificar que la sesión de Juanito permanece activa
    expect(authState.getAccessToken()).toBe(juanito.token);
  });

  it("Escenario 27: Un 401 por falta o invalidez de terminal (x-terminal-credential) NO cierra una sesión de usuario válida ni dispara auth:session-expired", async () => {
    terminalStorage.setCredential("credencial-terminal-inexistente-999");
    authState.setAccessToken(superAdminToken);

    let sessionExpiredDispatched = false;
    const onExpired = () => {
      sessionExpiredDispatched = true;
    };
    window.addEventListener("auth:session-expired", onExpired);

    try {
      // Llamar directamente a un endpoint que exige terminal con una credencial de terminal inválida
      await expect(httpClient.get("/auth/inspectores-offline")).rejects.toThrow(/terminal/i);

      // La sesión del usuario (`authState.getAccessToken()`) NO fue borrada y NO se disparó `auth:session-expired`
      expect(sessionExpiredDispatched).toBe(false);
      expect(authState.getAccessToken()).toBe(superAdminToken);
    } finally {
      window.removeEventListener("auth:session-expired", onExpired);
      terminalStorage.setCredential(terminalMontado.credencial);
    }
  });

  it("Escenario 28: La expiración real de sesión de usuario (JWT inválido/expirado + refresh 401) SÍ limpia el token y emite auth:session-expired", async () => {
    authState.setAccessToken("jwt.invalido.expirado");

    let sessionExpiredDispatched = false;
    const onExpired = () => {
      sessionExpiredDispatched = true;
    };
    window.addEventListener("auth:session-expired", onExpired);

    try {
      await expect(httpClient.get("/auth/me")).rejects.toThrow();
      expect(sessionExpiredDispatched).toBe(true);
      expect(authState.getAccessToken()).toBeNull();
    } finally {
      window.removeEventListener("auth:session-expired", onExpired);
    }
  });

  it("Escenario 29: Sincronización de capturas pendientes de extremo a extremo mediante inspeccionesOfflineService.sincronizarCola() preserva la identidad real de cada inspector y vacía la cola al confirmar en MySQL", async () => {
    terminalStorage.setCredential(terminalMontado.credencial);
    await idbDatabase.clear("cola_inspecciones");

    // 1. Encolar una captura de Juanito y otra de José en la misma PC
    const capJuanito = await inspeccionesOfflineService.encolarCaptura({
      inspector: { id: juanito.id, usuario: juanito.usuario, nombre: juanito.nombre },
      terminal: {
        id: terminalMontado.id,
        nombre: terminalMontado.nombre,
        departamentoId: deptoMontadoId,
      },
      payload: {
        lote: lotePrueba.lote,
        lineaTexto: "L1",
        detalles: [
          {
            defectoId: defectoMontado1.id,
            defDeptoId: deptoMontadoId,
            paresDefectuosos: 1,
          },
        ],
      },
    });

    const capJose = await inspeccionesOfflineService.encolarCaptura({
      inspector: { id: jose.id, usuario: jose.usuario, nombre: jose.nombre },
      terminal: {
        id: terminalMontado.id,
        nombre: terminalMontado.nombre,
        departamentoId: deptoMontadoId,
      },
      payload: {
        lote: lotePrueba.lote,
        lineaTexto: "L2",
        detalles: [
          {
            defectoId: defectoMontado2.id,
            defDeptoId: deptoMontadoId,
            paresDefectuosos: 2,
          },
        ],
      },
    });

    // 2. Simular logout y cierre/reapertura de conexión a IndexedDB (recarga de página)
    await idbDatabase.delete("sesion_offline", "activa");
    authState.setAccessToken(null);
    idbDatabase.closeConnection();

    const resumenAntes = await inspeccionesOfflineService.obtenerResumenCola();
    expect(resumenAntes.pendientes).toBe(2);

    // 3. Sincronizar la cola completa usando el servicio real del cliente (`sincronizarCola`)
    const resultadoSync = await inspeccionesOfflineService.sincronizarCola({
      forceIgnoreBackoff: true,
    });
    expect(resultadoSync.sincronizadas).toBe(2);
    expect(resultadoSync.pendientes).toBe(0);

    // 4. Confirmar que `cola_inspecciones` quedó vacía tras confirmación de MySQL
    const resumenDespues = await inspeccionesOfflineService.obtenerResumenCola();
    expect(resumenDespues.items.length).toBe(0);

    // 5. Confirmar en MySQL que cada captura conserva su inspector real (Juanito y José)
    const cabJuanito = await prisma.inspeccionCabecera.findUniqueOrThrow({
      where: {
        unique_inspector_clave_idempotencia: {
          inspectorId: juanito.id,
          claveIdempotencia: capJuanito.idLocalCliente,
        },
      },
    });
    const cabJose = await prisma.inspeccionCabecera.findUniqueOrThrow({
      where: {
        unique_inspector_clave_idempotencia: {
          inspectorId: jose.id,
          claveIdempotencia: capJose.idLocalCliente,
        },
      },
    });

    expect(cabJuanito.inspectorId).toBe(juanito.id);
    expect(cabJose.inspectorId).toBe(jose.id);
  });

  it("Escenario 30: Tabla local offline (obtenerFilasEnColaLocal) muestra inmediatamente las capturas pendientes de todos los inspectores de la terminal, filtra por búsqueda/papelera y se limpia tras sincronizar con MySQL", async () => {
    terminalStorage.setCredential(terminalMontado.credencial);
    await idbDatabase.clear("cola_inspecciones");

    // 1. Encolar una captura de Juanito con 2 defectos y otra de José con 1 defecto en la terminal de Montado
    const capJuanito = await inspeccionesOfflineService.encolarCaptura({
      inspector: { id: juanito.id, usuario: juanito.usuario, nombre: juanito.nombre },
      terminal: {
        id: terminalMontado.id,
        nombre: terminalMontado.nombre,
        departamentoId: deptoMontadoId,
      },
      payload: {
        lote: lotePrueba.lote,
        lineaTexto: "L1",
        detalles: [
          {
            defectoId: defectoMontado1.id,
            defectoClave: defectoMontado1.clave,
            defectoNombre: defectoMontado1.defecto,
            clasificacion: "MAYOR",
            defDeptoId: deptoMontadoId,
            defDeptoNombre: "MONTADO",
            paresDefectuosos: 2,
          },
          {
            defectoId: defectoMontado2.id,
            defectoClave: defectoMontado2.clave,
            defectoNombre: defectoMontado2.defecto,
            clasificacion: "MENOR",
            defDeptoId: deptoMontadoId,
            defDeptoNombre: "MONTADO",
            paresDefectuosos: 1,
          },
        ],
      },
    });

    const capJose = await inspeccionesOfflineService.encolarCaptura({
      inspector: { id: jose.id, usuario: jose.usuario, nombre: jose.nombre },
      terminal: {
        id: terminalMontado.id,
        nombre: terminalMontado.nombre,
        departamentoId: deptoMontadoId,
      },
      payload: {
        lote: lotePrueba.lote,
        lineaTexto: "L2",
        detalles: [
          {
            defectoId: defectoMontado1.id,
            defectoClave: defectoMontado1.clave,
            defectoNombre: defectoMontado1.defecto,
            clasificacion: "MAYOR",
            defDeptoId: deptoMontadoId,
            defDeptoNombre: "MONTADO",
            paresDefectuosos: 3,
          },
        ],
      },
    });

    // 2. Consultar las filas locales para la tabla de Montado (sin necesidad de red)
    const filasLocales = await inspeccionesOfflineService.obtenerFilasEnColaLocal({
      departamentoAuditoriaId: deptoMontadoId,
    });
    expect(filasLocales.length).toBe(3); // 2 detalles de Juanito + 1 detalle de José

    // Todas las filas locales tienen ID negativo determinístico y esLocalPendiente = true
    for (const fila of filasLocales) {
      expect(fila.id).toBeLessThan(0);
      expect(fila.esLocalPendiente).toBe(true);
      expect(fila.estadoColaLocal).toBe("PENDIENTE");
      expect(fila.lote).toBe(lotePrueba.lote);
      expect(fila.modelo).toBe(lotePrueba.modelo);
      expect(fila.lista).toBe(lotePrueba.lista);
      expect(fila.departamentoAuditoria).toBe("MONTADO");
    }

    // Verificar IDs determinísticos para resaltado de filas recién guardadas
    expect(filasLocales.some((f) => f.id === computeLocalRowId(capJuanito.idLocalCliente, 0))).toBe(true);
    expect(filasLocales.some((f) => f.id === computeLocalRowId(capJuanito.idLocalCliente, 1))).toBe(true);
    expect(filasLocales.some((f) => f.id === computeLocalRowId(capJose.idLocalCliente, 0))).toBe(true);

    // 3. Filtrado por búsqueda (ej. nombre del inspector José)
    const filtradasJose = await inspeccionesOfflineService.obtenerFilasEnColaLocal({
      departamentoAuditoriaId: deptoMontadoId,
      busqueda: "JOSE",
    });
    expect(filtradasJose.length).toBe(1);
    expect(filtradasJose[0]!.usuario).toBe(jose.nombre);

    // 4. En vista de papelera (soloEliminados = true) no aparecen capturas locales pendientes
    const enPapelera = await inspeccionesOfflineService.obtenerFilasEnColaLocal({
      departamentoAuditoriaId: deptoMontadoId,
      soloEliminados: true,
    });
    expect(enPapelera.length).toBe(0);

    // 5. Al sincronizar con el servidor, las filas locales desaparecen de la cola y ahora existen en MySQL
    const syncRes = await inspeccionesOfflineService.sincronizarCola({ forceIgnoreBackoff: true });
    expect(syncRes.sincronizadas).toBe(2);
    expect(syncRes.pendientes).toBe(0);

    const filasPostSync = await inspeccionesOfflineService.obtenerFilasEnColaLocal({
      departamentoAuditoriaId: deptoMontadoId,
    });
    expect(filasPostSync.length).toBe(0);
  });

  it("Escenario 31: Estado reactivo de alcanzabilidad del backend (connectivityState) detecta caída de red y recuperación automática", async () => {
    const eventos: boolean[] = [];
    const unsubscribe = connectivityState.subscribe((reachable) => {
      eventos.push(reachable);
    });

    const origBaseUrl = frontendEnv.API_BASE_URL;
    try {
      // Simular que el backend se apaga apuntando temporalmente a un puerto cerrado
      (frontendEnv as any).API_BASE_URL = "http://127.0.0.1:1/api/v1";
      await expect(httpClient.get("/departamentos")).rejects.toThrow();
      expect(connectivityState.isBackendReachable()).toBe(false);

      // Restaurar el backend y verificar que la siguiente petición marca reachable = true
      (frontendEnv as any).API_BASE_URL = origBaseUrl;
      authState.setAccessToken(juanito.token);
      const res = await httpClient.get<any>("/departamentos?activo=true");
      expect(res.success).toBe(true);
      expect(connectivityState.isBackendReachable()).toBe(true);
      expect(eventos).toContain(false);
      expect(eventos).toContain(true);
    } finally {
      (frontendEnv as any).API_BASE_URL = origBaseUrl;
      unsubscribe();
    }
  });

  // =========================================================================
  // ESCENARIOS 32 A 35 — AJUSTES OFFLINE EN DESARROLLO (MONTADO, CATÁLOGOS,
  // DIFERENCIACIÓN SIN CONEXIÓN VS SIN RESULTADOS Y MENSAJES CONCISOS)
  // =========================================================================

  it("Escenario 32: Con el backend apagado, consultarDefectosLocales({ etapaId: deptoMontadoId }) devuelve los defectos de Montado guardados en IndexedDB y respeta búsqueda, clasificación y paginación", async () => {
    terminalStorage.setCredential(terminalMontado.credencial);
    authState.setAccessToken(juanito.token);

    // 1. Con el backend disponible, sincronizar defectos de Montado y de Corte en IndexedDB
    const numMontado = await catalogoOfflineService.sincronizarDefectos(deptoMontadoId);
    expect(numMontado).toBeGreaterThan(0);

    const numCorte = await catalogoOfflineService.sincronizarDefectos(deptoCorteId);
    expect(numCorte).toBeGreaterThan(0);

    // 2. Apagar el backend simulando caída de red (puerto inaccesible)
    const origBaseUrl = frontendEnv.API_BASE_URL;
    (frontendEnv as any).API_BASE_URL = "http://127.0.0.1:1/api/v1";

    try {
      // 3. Consultar localmente los defectos de la etapa de Montado con el backend apagado
      const resMontadoLocal = await catalogoOfflineService.consultarDefectosLocales({
        etapaId: deptoMontadoId,
        activo: true,
        limit: 500,
      });

      expect(resMontadoLocal.esCacheLocal).toBe(true);
      expect(resMontadoLocal.items.length).toBe(numMontado);
      expect(resMontadoLocal.total).toBe(numMontado);

      // Todos los defectos devueltos deben tener permitido = true en la etapa de Montado
      const idsMontado = resMontadoLocal.items.map((d) => d.id);
      expect(idsMontado).toContain(defectoMontado1.id);
      expect(idsMontado).toContain(defectoMontado2.id);

      // 4. Probar filtrado local por búsqueda (clave o nombre de defectoMontado1)
      const resBusquedaClave = await catalogoOfflineService.consultarDefectosLocales({
        etapaId: deptoMontadoId,
        busqueda: String(defectoMontado1.clave),
        activo: true,
      });
      expect(resBusquedaClave.items.some((d) => d.id === defectoMontado1.id)).toBe(true);

      // 5. Probar paginación local (limit = 1, page = 1 y page = 2)
      const pag1 = await catalogoOfflineService.consultarDefectosLocales({
        etapaId: deptoMontadoId,
        activo: true,
        page: 1,
        limit: 1,
      });
      const pag2 = await catalogoOfflineService.consultarDefectosLocales({
        etapaId: deptoMontadoId,
        activo: true,
        page: 2,
        limit: 1,
      });
      expect(pag1.items.length).toBe(1);
      expect(pag2.items.length).toBe(1);
      expect(pag1.items[0]!.id).not.toBe(pag2.items[0]!.id);
      expect(pag1.totalPages).toBe(numMontado);
    } finally {
      (frontendEnv as any).API_BASE_URL = origBaseUrl;
    }
  });

  it("Escenario 33: Si IndexedDB no contiene el catálogo de defectos ni lotes cuando el backend está apagado, consultarDefectosLocales y buscarLotesLocales informan vacío sin inventar registros falsos", async () => {
    await idbDatabase.clear("cat_defectos");
    await idbDatabase.clear("cat_lotes");

    const origBaseUrl = frontendEnv.API_BASE_URL;
    (frontendEnv as any).API_BASE_URL = "http://127.0.0.1:1/api/v1";

    try {
      const resVacio = await catalogoOfflineService.consultarDefectosLocales({
        etapaId: deptoMontadoId,
        activo: true,
      });
      expect(resVacio.esCacheLocal).toBe(true);
      expect(resVacio.items.length).toBe(0);
      expect(resVacio.total).toBe(0);

      const lotesVacios = await catalogoOfflineService.buscarLotesLocales(lotePrueba.lote);
      expect(lotesVacios.length).toBe(0);
    } finally {
      (frontendEnv as any).API_BASE_URL = origBaseUrl;
    }

    // Restaurar catálogos desde el backend activo y verificar también el guardado oportunista (`guardarDefectosEnCacheLocal`)
    const resOnline = await api("GET", `/defectos?etapaId=${deptoMontadoId}&activo=true&limit=200`, {
      token: juanito.token,
    });
    expect(resOnline.status).toBe(200);
    await catalogoOfflineService.guardarDefectosEnCacheLocal(
      resOnline.json.data.items,
      deptoMontadoId,
    );

    await idbDatabase.put<LoteOfflineStore>("cat_lotes", {
      lote: lotePrueba.lote,
      id: lotePrueba.id,
      lista: lotePrueba.lista,
      idProducto: "PROD-1",
      modelo: lotePrueba.modelo,
      cantidad: lotePrueba.cantidad,
      horma: "94 EE",
      cliente: "MBC",
      actualizadoEn: new Date().toISOString(),
    });

    const recuperados = await catalogoOfflineService.consultarDefectosLocales({
      etapaId: deptoMontadoId,
      activo: true,
    });
    expect(recuperados.items.length).toBeGreaterThan(0);
  });

  it("Escenario 34: Un fallo de red en /api/v1/terminales/estado preserva el perfil local de la estación en IndexedDB, no vacía la tabla local ni invalida sesiones de usuario", async () => {
    terminalStorage.setCredential(terminalMontado.credencial);
    authState.setAccessToken(juanito.token);

    // Asegurar que el perfil de la terminal de Montado está guardado en IndexedDB
    await terminalStorage.saveProfileToIdb({
      id: terminalMontado.id,
      nombre: terminalMontado.nombre,
      departamentoId: deptoMontadoId,
      departamentoCodigo: "MONTADO",
      departamentoNombre: "MONTADO",
      estado: "ACTIVA",
    });

    // Encolar una captura pendiente en la estación de Montado
    await idbDatabase.clear("cola_inspecciones");
    await inspeccionesOfflineService.encolarCaptura({
      inspector: { id: juanito.id, usuario: juanito.usuario, nombre: juanito.nombre },
      terminal: {
        id: terminalMontado.id,
        nombre: terminalMontado.nombre,
        departamentoId: deptoMontadoId,
      },
      payload: {
        lote: lotePrueba.lote,
        lineaTexto: "L1",
        detalles: [
          {
            defectoId: defectoMontado1.id,
            defectoClave: defectoMontado1.clave,
            defectoNombre: defectoMontado1.defecto,
            clasificacion: "MAYOR",
            defDeptoId: deptoMontadoId,
            defDeptoNombre: "MONTADO",
            paresDefectuosos: 2,
          },
        ],
      },
    });

    const origBaseUrl = frontendEnv.API_BASE_URL;
    (frontendEnv as any).API_BASE_URL = "http://127.0.0.1:1/api/v1";

    try {
      // Simular fallo de /terminales/estado con backend apagado
      await expect(httpClient.get("/terminales/estado")).rejects.toThrow();
      expect(connectivityState.isBackendReachable()).toBe(false);

      // El perfil local de la estación sigue disponible en IndexedDB
      const perfilLocal = await terminalStorage.getProfileFromIdb();
      expect(perfilLocal).not.toBeNull();
      expect(perfilLocal!.departamentoId).toBe(deptoMontadoId);
      expect(perfilLocal!.departamentoNombre).toBe("MONTADO");

      // Las filas locales de la tabla de Montado siguen disponibles y no se vacían
      const filasLocales = await inspeccionesOfflineService.obtenerFilasEnColaLocal({
        departamentoAuditoriaId: perfilLocal!.departamentoId,
      });
      expect(filasLocales.length).toBe(1);
      expect(filasLocales[0]!.defectoNombre).toBe(defectoMontado1.defecto);

      // La sesión del usuario no se cerró por el fallo de red
      expect(authState.getAccessToken()).toBe(juanito.token);
    } finally {
      (frontendEnv as any).API_BASE_URL = origBaseUrl;
      // Limpiar la cola sincronizando al recuperar el servidor
      await inspeccionesOfflineService.sincronizarCola({ forceIgnoreBackoff: true });
    }
  });

  it("Escenario 35: Diferenciación entre error HTTP (ApiError) y caída de red en httpClient, preservación de capturas tras cambio de inspector y sincronización sin duplicados al volver el backend", async () => {
    terminalStorage.setCredential(terminalMontado.credencial);
    authState.setAccessToken(juanito.token);
    await idbDatabase.clear("cola_inspecciones");

    // 1. Un error HTTP del servidor (ej. 400 / 404) lanza ApiError pero mantiene connectivityState.isBackendReachable() === true
    await expect(httpClient.get("/lotes/LOTE_INEXISTENTE_999999")).rejects.toThrow();
    expect(connectivityState.isBackendReachable()).toBe(true);

    // 2. Apagar el backend y registrar una captura con Juanito y otra después de cambiar al inspector José
    const origBaseUrl = frontendEnv.API_BASE_URL;
    (frontendEnv as any).API_BASE_URL = "http://127.0.0.1:1/api/v1";

    let capJuanitoId = "";
    let capJoseId = "";

    try {
      const cap1 = await inspeccionesOfflineService.encolarCaptura({
        inspector: { id: juanito.id, usuario: juanito.usuario, nombre: juanito.nombre },
        terminal: {
          id: terminalMontado.id,
          nombre: terminalMontado.nombre,
          departamentoId: deptoMontadoId,
        },
        payload: {
          lote: lotePrueba.lote,
          lineaTexto: "L1",
          detalles: [
            {
              defectoId: defectoMontado1.id,
              defectoClave: defectoMontado1.clave,
              defectoNombre: defectoMontado1.defecto,
              clasificacion: "MAYOR",
              defDeptoId: deptoMontadoId,
              defDeptoNombre: "MONTADO",
              paresDefectuosos: 1,
            },
          ],
        },
      });
      capJuanitoId = cap1.idLocalCliente;

      // Cambiar de inspector a José mientras el servidor sigue desconectado
      await offlineAuthClientService.authenticateOffline({
        usuario: jose.nombre,
        password: jose.password,
      });

      const cap2 = await inspeccionesOfflineService.encolarCaptura({
        inspector: { id: jose.id, usuario: jose.usuario, nombre: jose.nombre },
        terminal: {
          id: terminalMontado.id,
          nombre: terminalMontado.nombre,
          departamentoId: deptoMontadoId,
        },
        payload: {
          lote: lotePrueba.lote,
          lineaTexto: "L2",
          detalles: [
            {
              defectoId: defectoMontado2.id,
              defectoClave: defectoMontado2.clave,
              defectoNombre: defectoMontado2.defecto,
              clasificacion: "MENOR",
              defDeptoId: deptoMontadoId,
              defDeptoNombre: "MONTADO",
              paresDefectuosos: 2,
            },
          ],
        },
      });
      capJoseId = cap2.idLocalCliente;

      // Ambas capturas permanecen visibles en la tabla local de Montado después del cambio de inspector
      const filasEnTabla = await inspeccionesOfflineService.obtenerFilasEnColaLocal({
        departamentoAuditoriaId: deptoMontadoId,
      });
      expect(filasEnTabla.length).toBe(2);
      expect(filasEnTabla.some((f) => f.usuario === juanito.nombre)).toBe(true);
      expect(filasEnTabla.some((f) => f.usuario === jose.nombre)).toBe(true);
    } finally {
      (frontendEnv as any).API_BASE_URL = origBaseUrl;
    }

    // 3. Al regresar el backend, la sincronización automática envía ambas capturas y no duplica registros
    const sync1 = await inspeccionesOfflineService.sincronizarCola({ forceIgnoreBackoff: true });
    expect(sync1.sincronizadas).toBe(2);
    expect(sync1.pendientes).toBe(0);

    const sync2 = await inspeccionesOfflineService.sincronizarCola({ forceIgnoreBackoff: true });
    expect(sync2.sincronizadas).toBe(0);

    const countJuanito = await prisma.inspeccionCabecera.count({
      where: { inspectorId: juanito.id, claveIdempotencia: capJuanitoId },
    });
    const countJose = await prisma.inspeccionCabecera.count({
      where: { inspectorId: jose.id, claveIdempotencia: capJoseId },
    });
    expect(countJuanito).toBe(1);
    expect(countJose).toBe(1);
  });
});
