import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import jwt from "jsonwebtoken";
import { authenticator } from "otplib";
import { prisma } from "../lib/prisma";
import { HttpError } from "../middleware/errorHandler";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "../utils/jwt";
import { authRequired } from "../middleware/auth";
import { audit } from "../utils/audit";

const router = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

router.post("/login", async (req, res, next) => {
  try {
    const { email, password } = loginSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email }, include: { driver: true } });
    if (!user || !user.active) throw new HttpError(401, "Credenciais inválidas");
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) throw new HttpError(401, "Credenciais inválidas");

    // Se 2FA ativo → exige segunda etapa antes de emitir tokens
    if (user.totpEnabled && user.totpSecret) {
      const totpToken = jwt.sign(
        { id: user.id, scope: "totp" },
        process.env.JWT_SECRET!,
        { expiresIn: "5m" }
      );
      return res.json({ totpRequired: true, totpToken });
    }

    const payload = { id: user.id, email: user.email, role: user.role };
    const accessToken = signAccessToken(payload);
    const refreshToken = signRefreshToken(payload);

    await prisma.refreshToken.create({
      data: {
        token: refreshToken,
        userId: user.id,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    await audit({ userId: user.id, action: "LOGIN", entity: "User", entityId: user.id, ip: req.ip });

    res.json({
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        avatarUrl: user.avatarUrl,
        driverId: user.driver?.id ?? null,
      },
    });
  } catch (e) {
    next(e);
  }
});

// Segunda etapa do login com 2FA
router.post("/login/2fa", async (req, res, next) => {
  try {
    const { totpToken, code } = z
      .object({ totpToken: z.string(), code: z.string().min(6).max(8) })
      .parse(req.body);
    let payload: any;
    try {
      payload = jwt.verify(totpToken, process.env.JWT_SECRET!);
    } catch {
      throw new HttpError(401, "Sessão 2FA expirada — faça login novamente");
    }
    if (payload.scope !== "totp") throw new HttpError(401, "Token inválido");
    const user = await prisma.user.findUnique({ where: { id: payload.id }, include: { driver: true } });
    if (!user?.totpSecret || !user.totpEnabled) throw new HttpError(401, "2FA não configurado");
    const valid = authenticator.verify({ token: code.replace(/\s/g, ""), secret: user.totpSecret });
    if (!valid) throw new HttpError(401, "Código incorreto");

    const tokenPayload = { id: user.id, email: user.email, role: user.role };
    const accessToken = signAccessToken(tokenPayload);
    const refreshToken = signRefreshToken(tokenPayload);
    await prisma.refreshToken.create({
      data: { token: refreshToken, userId: user.id, expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) },
    });
    await audit({ userId: user.id, action: "LOGIN_2FA", entity: "User", entityId: user.id, ip: req.ip });
    res.json({
      accessToken,
      refreshToken,
      user: { id: user.id, name: user.name, email: user.email, role: user.role, avatarUrl: user.avatarUrl, driverId: user.driver?.id ?? null },
    });
  } catch (e) {
    next(e);
  }
});

router.post("/refresh", async (req, res, next) => {
  try {
    const { refreshToken } = z.object({ refreshToken: z.string() }).parse(req.body);
    const stored = await prisma.refreshToken.findUnique({ where: { token: refreshToken } });
    if (!stored || stored.revoked || stored.expiresAt < new Date())
      throw new HttpError(401, "Refresh token inválido");
    const payload = verifyRefreshToken(refreshToken);
    const accessToken = signAccessToken({ id: payload.id, email: payload.email, role: payload.role });
    res.json({ accessToken });
  } catch (e) {
    next(e);
  }
});

router.post("/logout", authRequired, async (req, res, next) => {
  try {
    const { refreshToken } = z.object({ refreshToken: z.string().optional() }).parse(req.body);
    if (refreshToken) {
      await prisma.refreshToken.updateMany({
        where: { token: refreshToken },
        data: { revoked: true },
      });
    }
    await audit({ userId: req.user!.id, action: "LOGOUT", entity: "User", entityId: req.user!.id });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

router.get("/me", authRequired, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      include: { driver: true },
    });
    if (!user) throw new HttpError(404, "Usuário não encontrado");
    res.json({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      avatarUrl: user.avatarUrl,
      driverId: user.driver?.id ?? null,
    });
  } catch (e) {
    next(e);
  }
});

export default router;
