import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

export const generateAccessToken = (userId, role) =>
  jwt.sign({ id: userId, role }, env.jwtSecret, {
    expiresIn: env.jwtExpires,
  });

export const generateRefreshToken = (userId) =>
  jwt.sign({ id: userId }, env.jwtRefreshSecret, {
    expiresIn: env.jwtRefreshExpires,
  });

export const verifyAccessToken = (token) => jwt.verify(token, env.jwtSecret);

export const verifyRefreshToken = (token) => jwt.verify(token, env.jwtRefreshSecret);
