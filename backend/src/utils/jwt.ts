import jwt, { SignOptions } from "jsonwebtoken";
import { Role } from "@prisma/client";

export interface JwtPayload {
  id: string;
  email: string;
  role: Role;
}

export function signAccessToken(payload: JwtPayload) {
  const opts: SignOptions = { expiresIn: (process.env.JWT_EXPIRES_IN as any) ?? "15m" };
  return jwt.sign(payload, process.env.JWT_SECRET!, opts);
}

export function signRefreshToken(payload: JwtPayload) {
  const opts: SignOptions = { expiresIn: (process.env.JWT_REFRESH_EXPIRES_IN as any) ?? "7d" };
  return jwt.sign(payload, process.env.JWT_REFRESH_SECRET!, opts);
}

export function verifyRefreshToken(token: string): JwtPayload {
  return jwt.verify(token, process.env.JWT_REFRESH_SECRET!) as JwtPayload;
}
