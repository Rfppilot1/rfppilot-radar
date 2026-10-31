/**
 * Document links that need help to open.
 *
 * MyFloridaMarketPlace serves an attachment only when the request asks for a file
 * (`Accept: application/octet-stream`); a plain link, as a browser sends it, gets the portal's web app instead.
 * So Florida documents are linked through Radar's own `/docs/mfmp/<attachmentId>` route, which asks for the file
 * and passes it through. Every other document keeps its original link.
 */
import { safeHref } from "./format";

export const MFMP_DOWNLOAD = "https://vendor.myfloridamarketplace.com/mfmp/bids/detail/attachment/download";

/** The MFMP attachment id in a document link, or null when the link is not an MFMP attachment. */
export function mfmpAttachmentId(url: string | null | undefined): string | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (`${u.origin}${u.pathname}` !== MFMP_DOWNLOAD) return null;
  const id = u.searchParams.get("attachmentId") ?? "";
  return /^\d{1,12}$/.test(id) ? id : null;
}

/** The link to show for a document: Radar's route for MFMP attachments, the original http(s) link otherwise. */
export function documentHref(url: string | null | undefined): string | null {
  const id = mfmpAttachmentId(url);
  return id ? `/docs/mfmp/${id}` : safeHref(url);
}

/**
 * A safe download file name from the portal's Content-Disposition header: path parts, quotes and control
 * characters removed, at most 150 characters. Null when nothing usable is left.
 */
export function safeFilename(disposition: string | null): string | null {
  if (!disposition) return null;
  const star = /filename\*\s*=\s*(?:UTF-8''|utf-8'')([^;]+)/.exec(disposition);
  let name: string | null = null;
  if (star) {
    try {
      name = decodeURIComponent(star[1]!.trim());
    } catch {
      name = null;
    }
  }
  if (!name) {
    const plain = /filename\s*=\s*("?)([^";]+)\1/.exec(disposition);
    name = plain ? plain[2]!.trim() : null;
  }
  if (!name) return null;
  const cleaned = name
    .split(/[\\/]/)
    .pop()!
    .replace(/[\u0000-\u001f\u007f"]/g, "")
    .trim()
    .slice(0, 150);
  return cleaned.length > 0 && cleaned !== "." && cleaned !== ".." ? cleaned : null;
}
