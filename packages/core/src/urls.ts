/**
 * Document links come from the agencies' own data and are handed to RFP Pilot, whose server downloads them.
 * Only links that point at the public internet may leave Radar: http(s) only, and never a loopback, private,
 * link-local or cloud-metadata address, or a bare intranet name. This blocks the obvious server-side request
 * forgery paths (e.g. http://169.254.169.254/); a downloader must still re-check the address it resolves to,
 * because a public name can point at a private address.
 */
export function isPublicUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost")) return false;
  if (/\.(local|internal|intranet|lan|home|corp)$/.test(host)) return false;
  if (host.includes(":")) return !privateIpv6(host);
  if (/^\d+(\.\d+){3}$/.test(host)) return !privateIpv4(host);
  // A name with no dot is an intranet host; a numeric-looking name in another form (0x7f.1, 2130706433) is
  // an address in disguise.
  if (!host.includes(".") || /^[0-9.x]+$/.test(host)) return false;
  return true;
}

function privateIpv4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number) as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function privateIpv6(ip: string): boolean {
  if (ip === "::" || ip === "::1") return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (mapped) return privateIpv4(mapped[1]!);
  if (/^::ffff:/.test(ip)) return true;
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(ip);
}
