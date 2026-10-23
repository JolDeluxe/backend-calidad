import { Router } from "express";
import { sessionController } from "./controllers/session.controller";
import { validate } from "../../middlewares/validate";
import { authenticate } from "../../middlewares/auth";
import { loginSchema } from "./auth.schema";

const router = Router();

router.post(
  "/login",
  validate({ body: loginSchema }),
  (req, res, next) => sessionController.login(req, res, next),
);

router.post(
  "/refresh",
  (req, res, next) => sessionController.refresh(req, res, next),
);

router.post(
  "/logout",
  (req, res, next) => sessionController.logout(req, res, next),
);

router.get(
  "/me",
  authenticate,
  (req, res, next) => sessionController.getMe(req, res, next),
);

export const authRouter = router;