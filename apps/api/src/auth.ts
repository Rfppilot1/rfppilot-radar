import { createHash, timingSafeEqual } from "node:crypto";

/**
 * API-key authentication. Keys map to exactly one tenant. Keys are held as SHA-256 digests and compared in
 * constant time, so a leaked config dump or timing probe does not reveal a usable key.
 *
 * Configuration: RADAR_API_KEYS="tenantA:key1,tenantB:key2". Production should load keys from a secrets
 * manager; rotation is adding the new key, deploying, then removing the old one.
 */
export class ApiKeyAuth {
  private readonly entries: { tenantId: string; digest: Buffer }[];

  constructor(pairs: { tenantId: string; key: string }[]) {
    for (const p of pairs) {
      if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(p.tenantId)) throw new Error(`Invalid tenant id "${p.tenantId}"`);
      if (p.key.length < 16)
        throw new Error(`API key for tenant "${p.tenantId}" must be at least 16 characters`);
    }
    this.entries = pairs.map((p) => ({ tenantId: p.tenantId, digest: sha(p.key) }));
  }

  static fromEnv(value: string | undefined): ApiKeyAuth {
    const pairs = (value ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const i = s.indexOf(":");
        if (i < 1) throw new Error("RADAR_API_KEYS entries must look like tenant:key");
        return { tenantId: s.slice(0, i), key: s.slice(i + 1) };
      });
    return new ApiKeyAuth(pairs);
  }

  /** Returns the tenant for a presented key, or null. Checks every entry to keep timing uniform. */
  tenantFor(presented: string | undefined): string | null {
    if (!presented) return null;
    const d = sha(presented);
    let found: string | null = null;
    for (const e of this.entries) if (timingSafeEqual(d, e.digest)) found = e.tenantId;
    return found;
  }
}

const sha = (s: string) => createHash("sha256").update(s).digest();
