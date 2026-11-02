import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "../app/docs/mfmp/[id]/route";

const call = (id: string) =>
  GET(new Request(`http://radar.test/docs/mfmp/${id}`), { params: Promise.resolve({ id }) });

describe("MFMP document route", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("asks MFMP for the file and passes it through with a safe name", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response("%PDF-1.7", {
          headers: {
            "content-type": "application/pdf",
            "content-disposition": 'attachment; filename="RFP ECD - Revised Services.pdf"',
            "content-length": "8",
          },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const res = await call("48213");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("%PDF-1.7");
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe(
      "attachment; filename*=UTF-8''RFP%20ECD%20-%20Revised%20Services.pdf",
    );
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      "https://vendor.myfloridamarketplace.com/mfmp/bids/detail/attachment/download?attachmentId=48213",
    );
    expect((init.headers as Record<string, string>).Accept).toBe("application/octet-stream");
  });

  it("refuses non-numeric ids without calling MFMP", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect((await call("1%2F..%2Fx")).status).toBe(404);
    expect((await call("abc")).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a missing document when MFMP answers with its web app instead of a file", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html></html>", { headers: { "content-type": "text/html" } })),
    );
    expect((await call("7")).status).toBe(404);
  });

  it("serves unexpected content types as a download, never as a page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response("<svg onload=alert(1)>", { headers: { "content-type": "image/svg+xml" } }),
      ),
    );
    const res = await call("9");
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("says when MFMP does not respond", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("timeout");
      }),
    );
    expect((await call("10")).status).toBe(502);
  });
});
