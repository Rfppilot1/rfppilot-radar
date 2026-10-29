import { NextResponse, type NextRequest } from "next/server";

/**
 * Staging gate and visit tracking.
 * - Every page asks for WEB_PASSWORD (HTTP Basic, any user name). Production will use WorkOS.
 *   A production build with no password refuses to serve (fails closed) unless WEB_AUTH_DISABLED=1 says so on purpose.
 * - "New since my last visit": a visit is a run of requests with gaps under 30 minutes. When a new visit starts,
 *   the previous visit's last-seen time is kept in `radar_pv` and passed to pages as a request header.
 */
const SESSION_GAP_MS = 30 * 60 * 1000;

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function proxy(req: NextRequest) {
  const password = process.env.WEB_PASSWORD;
  if (!password && process.env.NODE_ENV === "production" && process.env.WEB_AUTH_DISABLED !== "1")
    return new NextResponse("Not configured: set WEB_PASSWORD", { status: 503 });
  if (password) {
    const header = req.headers.get("authorization") ?? "";
    const [scheme, encoded] = header.split(" ");
    let given = "";
    if (scheme === "Basic" && encoded) {
      try {
        const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
        given = new TextDecoder().decode(bytes).split(":").slice(1).join(":");
      } catch {
        given = "";
      }
    }
    if (!timingSafeEqual(given, password))
      return new NextResponse("Password required", {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="RFP Pilot Radar (staging)"' },
      });
  }

  const now = Date.now();
  const lastSeen = Number(req.cookies.get("radar_ls")?.value ?? 0);
  let previous = req.cookies.get("radar_pv")?.value ?? "";
  const newVisit = !lastSeen || now - lastSeen > SESSION_GAP_MS;
  if (newVisit && lastSeen) previous = new Date(lastSeen).toISOString();

  const headers = new Headers(req.headers);
  headers.set("x-radar-previous-visit", previous);
  const res = NextResponse.next({ request: { headers } });
  const cookie = {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: true,
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  };
  res.cookies.set("radar_ls", String(now), cookie);
  if (previous) res.cookies.set("radar_pv", previous, cookie);
  return res;
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
