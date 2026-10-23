import type { Request, Response, NextFunction } from "express";
import { lotesService } from "./services/lotes.service";
import { sendSuccess } from "../../utils/response";

export class LotesController {
  async getByCodigo(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const loteCodigo = req.params.lote as string;
      const lote = await lotesService.getByCodigoLote(loteCodigo);
      sendSuccess(res, lote, "Lote recuperado exitosamente");
    } catch (error) {
      next(error);
    }
  }

  async searchLotes(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { busqueda, lista, modelo, cliente, page, limit } = req.query as unknown as {
        busqueda?: string;
        lista?: string;
        modelo?: string;
        cliente?: string;
        page: number;
        limit: number;
      };

      const resultado = await lotesService.searchLotes({
        busqueda,
        lista,
        modelo,
        cliente,
        page: Number(page) || 1,
        limit: Number(limit) || 20,
      });

      sendSuccess(res, resultado, "Lotes consultados exitosamente");
    } catch (error) {
      next(error);
    }
  }
}

export const lotesController = new LotesController();
