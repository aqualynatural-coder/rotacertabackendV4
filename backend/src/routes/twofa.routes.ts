// ============================================================
// 2FA (TOTP) para administradores — Google Authenticator / Authy
// ============================================================
import { Router } from "express";
import { z } from "zod";
import { authenticator } from "otplib";
import QRCode from "qrcode";
import { Role } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { authRequired, requireRole } from "../middleware/auth";
import { HttpError } from "../middleware/errorHandler";
import { audit } from "../utils/audit";

const router = Router();
router.use(authRequired, requireRole(Role.ADMIN));

// POST /2fa/setup — gera segredo + QR Code (ainda não ativa)
router.post("/setup", async (req, res, next) => {
  try {
    const secret = authenticator.generateSecret();
    await prisma.user.update({
      where: { id: req.user!.id },
      data: { totpSecret: secret, totpEnabled: false },
    });
    const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
    const otpauth = authenticator.keyuri(user!.email, "RotaCerta", secret);
    const qrDataUrl = await QRCode.toDataURL(otpauth, { width: 240 });
    res.json({ secret, qrDataUrl });
  } catch (e) {
    next(e);
  }
});

// POST /2fa/enable — valida primeiro código e ativa
router.post("/enable", async (req, res, next) => {
  try {
    const { code } = z.object({ code: z.string().min(6).max(8) }).parse(req.body);
    const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
    if (!user?.totpSecret) throw new HttpError(400, "Execute /2fa/setup primeiro");
    const valid = authenticator.verify({ token: code.replace(/\s/g, ""), secret: user.totpSecret });
    if (!valid) throw new HttpError(400, "Código inválido");
    await prisma.user.update({ where: { id: user.id }, data: { totpEnabled: true } });
    await audit({ userId: user.id, action: "2FA_ENABLED", entity: "User", entityId: user.id });
    res.json({ ok: true, totpEnabled: true });
  } catch (e) {
    next(e);
  }
});

// POST /2fa/disable — desativa (exige código atual)
router.post("/disable", async (req, res, next) => {
  try {
    const { code } = z.object({ code: z.string().min(6).max(8) }).parse(req.body);
    const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
    if (!user?.totpSecret || !user.totpEnabled) throw new HttpError(400, "2FA não está ativo");
    const valid = authenticator.verify({ token: code.replace(/\s/g, ""), secret: user.totpSecret });
    if (!valid) throw new HttpError(400, "Código inválido");
    await prisma.user.update({
      where: { id: user.id },
      data: { totpEnabled: false, totpSecret: null },
    });
    await audit({ userId: user.id, action: "2FA_DISABLED", entity: "User", entityId: user.id });
    res.json({ ok: true, totpEnabled: false });
  } catch (e) {
    next(e);
  }
});

// GET /2fa/status
router.get("/status", async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
    res.json({ totpEnabled: user?.totpEnabled ?? false });
  } catch (e) {
    next(e);
  }
});

export default router;
