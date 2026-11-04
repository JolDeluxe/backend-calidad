import { seedDefectosUnificado } from './seed-defectos-unificado';
import { prisma } from '../src/config/database';

/**
 * Script de importación del catálogo de defectos oficial unificado.
 *
 * NOTA DE ARQUITECTURA (FASE 2 / 2.1):
 * El antiguo archivo Catalogo_Def.txt contenía 357 defectos desactualizados y sobrescribía
 * la matriz de visibilidad creando registros en DefectoEtapa por cada etapa.
 * Ahora se utiliza el Catálogo Unificado y Corregido (289 defectos oficiales)
 * alineado con el nuevo modelo de Herencia Dinámica de Matriz Maestra.
 */
async function main() {
  console.log('=================================================================');
  console.log('Invocando importación de Catálogo Unificado de Defectos');
  console.log('=================================================================');
  await seedDefectosUnificado();
}

if (import.meta.main) {
  main()
    .catch((err) => {
      console.error('Error durante la importación:', err);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
      process.exit(0);
    });
}

export { main as importarCatalogoDefectos };
