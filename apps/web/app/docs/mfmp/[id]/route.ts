import { MFMP_DOWNLOAD, safeFilename } from "../../../../lib/docs";

/**
 * Opens a MyFloridaMarketPlace attachment. The portal returns the file only when asked for one
 * (`Accept: application/octet-stream`), so this route asks and passes the file through. Only numeric attachment
 * ids are accepted and only the MFMP download address is ever fetched; the staging password gate covers this route.
 */
export const dynamic = "force-dynamic";

const PASS_TYPES =
  /^(application\/(pdf|msword|zip|octet-stream|vnd\.[\w.+-]+)|text\/(plain|csv)|image\/(png|jpeg))\b/i;

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^\d{1,12}$/.test(id)) return new Response("Not found", { status: 404 });

  let upstream: Response;
  try {
    upstream = await fetch(`${MFMP_DOWNLOAD}?attachmentId=${id}`, {
      headers: { Accept: "application/octet-stream" },
      redirect: "follow",
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return new Response(
      "MyFloridaMarketPlace did not respond. Try again, or open the posting on the portal.",
      {
        status: 502,
      },
    );
  }
  const type = upstream.headers.get("content-type") ?? "";
  // The portal answers a bad id with its web app (HTML), not an error code.
  if (!upstream.ok || !upstream.body || /text\/html/i.test(type))
    return new Response("This document is not available from MyFloridaMarketPlace.", { status: 404 });

  const filename = safeFilename(upstream.headers.get("content-disposition")) ?? `mfmp-${id}`;
  const headers = new Headers({
    "Content-Type": PASS_TYPES.test(type) ? type : "application/octet-stream",
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, max-age=3600",
  });
  const length = upstream.headers.get("content-length");
  if (length && /^\d+$/.test(length)) headers.set("Content-Length", length);
  return new Response(upstream.body, { status: 200, headers });
}
