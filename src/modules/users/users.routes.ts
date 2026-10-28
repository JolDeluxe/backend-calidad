import { Router } from "express";
import { usersController } from "./controllers/users.controller";
import { authenticate, requireRole } from "../../middlewares/auth";
import { validate } from "../../middlewares/validate";
import {
  createUserSchema,
  updateUserSchema,
  userIdParamSchema,
  suggestUsernameQuerySchema,
} from "./users.schema";

const router = Router();

router.use(authenticate);

router.get("/roles", (req, res, next) => usersController.getRoles(req, res, next));

router.get(
  "/suggest-username",
  validate({ query: suggestUsernameQuerySchema }),
  (req, res, next) => usersController.suggestUsername(req, res, next),
);

router.get("/", (req, res, next) => usersController.getUsers(req, res, next));

router.get(
  "/:id",
  validate({ params: userIdParamSchema }),
  (req, res, next) => usersController.getUserById(req, res, next),
);

router.post(
  "/",
  requireRole(["SUPER_ADMIN", "ADMIN"]),
  validate({ body: createUserSchema }),
  (req, res, next) => usersController.createUser(req, res, next),
);

router.patch(
  "/:id",
  requireRole(["SUPER_ADMIN", "ADMIN"]),
  validate({ params: userIdParamSchema, body: updateUserSchema }),
  (req, res, next) => usersController.updateUser(req, res, next),
);

router.delete(
  "/:id",
  requireRole(["SUPER_ADMIN", "ADMIN"]),
  validate({ params: userIdParamSchema }),
  (req, res, next) => usersController.deleteUser(req, res, next),
);

export const usersRouter = router;
