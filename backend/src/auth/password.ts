/**
 * Password hashing — port of the libpass/fastapi-users password layer.
 *
 * Python source:
 *   - /home/z/onyx/backend/onyx/auth/users.py (UserManager.password_helper =
 *     fastapi_users PasswordHelper, passlib CryptContext schemes=["bcrypt"])
 *   - /home/z/onyx/backend/onyx/db/users.py (_generate_password_hash -> PasswordHelper)
 *   - /home/z/onyx/backend/onyx/auth/api_key.py (PasswordHelper usage for API-key users)
 *
 * Verification in Onyx: user_manager.authenticate -> password_helper.verify_and_update,
 * i.e. bcrypt.checkpw semantics. Bun.password implements bcrypt natively; we pin
 * cost 12, the passlib bcrypt default that fastapi_users inherits.
 */
import { getLogger } from "../utils/logger.js";
import bcrypt from "bcryptjs";

/** Bun exposes native bcrypt; on Node (Vercel serverless) we use bcryptjs. */
const hasBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

const logger = getLogger("auth.password");

const BCRYPT_COST = 12;

/** Hash a plaintext password with bcrypt (passlib default cost 12). */
export async function hashPassword(password: string): Promise<string> {
  if (hasBun) {
    return Bun.password.hash(password, { algorithm: "bcrypt", cost: BCRYPT_COST });
  }
  // bcryptjs produces the $2a$ prefix; normalize to $2b$ for passlib parity
  // ($2a$ and $2b$ verify identically everywhere).
  const hash = await bcrypt.hash(password, BCRYPT_COST);
  return hash.startsWith("$2a$") ? "$2b$" + hash.slice(4) : hash;
}

/**
 * Constant-time bcrypt verification. Returns false instead of throwing when the
 * stored hash is malformed, so login always yields a clean invalid-credential path.
 */
export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  if (!passwordHash) return false;
  try {
    if (hasBun) {
      return await Bun.password.verify(password, passwordHash);
    }
    return await bcrypt.compare(password, passwordHash);
  } catch (err) {
    logger.warning("password verify failed (malformed hash?)", { error: String(err) });
    return false;
  }
}
