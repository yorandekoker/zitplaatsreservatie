import express from "express";
import customerRoutes from "./routes/customer";
import adminRoutes from "./routes/admin";
import apiRoutes from "./routes/api";

const router = express.Router();

router.use(customerRoutes);
router.use(adminRoutes);
router.use(apiRoutes);

export default router;