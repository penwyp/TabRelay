import http from "node:http";
import crypto from "node:crypto";
export async function startDav() {
  const files = new Map(),
    dirs = new Set(["/", "/dav/"]);
  const requests = [];
  const faults = { status: 0, offline: false, delay: 0 };
  const etag = (b) =>
    '"' + crypto.createHash("sha256").update(b).digest("hex") + '"';
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost"),
      path = url.pathname;
    requests.push({ method: req.method, path });
    if (path === "/fixture/body-privacy") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(`<!doctype html><html><head><title>公开研究笔记</title>
        <style>.hidden-css{display:none}.invisible-css{visibility:hidden}</style></head>
        <body><main><h1>研究资料</h1><p>量子陀螺导航的低温校准采用蓝宝石谐振腔。</p>
        <p>Visible English body marker sapphire-resonator-protocol.</p></main>
        <input value="SECRET_INPUT_739"><textarea>SECRET_TEXTAREA_739</textarea>
        <div contenteditable="true">SECRET_EDITABLE_739</div>
        <form><p>SECRET_FORM_739</p><select><option>SECRET_SELECT_739</option></select></form>
        <div hidden>SECRET_HIDDEN_739</div><div class="hidden-css">SECRET_CSS_739</div>
        <div class="invisible-css">SECRET_INVISIBLE_739</div>
        <script>window.fixtureSecret="SECRET_SCRIPT_739"</script>
        <noscript>SECRET_NOSCRIPT_739</noscript></body></html>`);
      return;
    }
    if (path.startsWith("/fixture/")) {
      res.setHeader("Content-Type", "text/html");
      res.end(
        `<html><title>${path.split("/").pop()}</title><body style="font:24px system-ui;padding:40px">TabRelay test page: ${path.split("/").pop()}</body></html>`,
      );
      return;
    }
    if (faults.offline) {
      req.socket.destroy();
      return;
    }
    if (faults.delay) await new Promise((r) => setTimeout(r, faults.delay));
    if (faults.status) {
      res.writeHead(faults.status);
      res.end("injected");
      return;
    }
    let body = "";
    for await (const c of req) body += c;
    const prior = files.get(path);
    if (req.method === "MKCOL") {
      if (dirs.has(path)) {
        res.statusCode = 405;
      } else {
        dirs.add(path);
        res.statusCode = 201;
      }
      res.end();
      return;
    }
    if (req.method === "PROPFIND") {
      if (!dirs.has(path)) {
        res.statusCode = 404;
        res.end();
        return;
      }
      const children = [...dirs, ...files.keys()].filter(
        (p) =>
          p.startsWith(path) &&
          (p === path ||
            !p.slice(path.length).replace(/\/$/, "").includes("/")),
      );
      res.writeHead(207, { "Content-Type": "application/xml" });
      res.end(
        '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">' +
          children
            .map((p) => `<d:response><d:href>${p}</d:href></d:response>`)
            .join("") +
          "</d:multistatus>",
      );
      return;
    }
    if (req.method === "GET") {
      if (prior === undefined) {
        res.statusCode = 404;
        res.end();
        return;
      }
      res.setHeader("ETag", etag(prior));
      res.end(prior);
      return;
    }
    if (req.method === "PUT" || req.method === "DELETE") {
      if (
        (req.headers["if-none-match"] === "*" && prior !== undefined) ||
        (req.headers["if-match"] &&
          (prior === undefined || req.headers["if-match"] !== etag(prior)))
      ) {
        res.statusCode = 412;
        res.end();
        return;
      }
      if (req.method === "DELETE") {
        files.delete(path);
        res.statusCode = 204;
      } else {
        files.set(path, body);
        res.statusCode = 201;
        res.setHeader("ETag", etag(body));
      }
      res.end();
      return;
    }
    res.statusCode = 405;
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    server,
    origin,
    endpoint: origin + "/dav/",
    files,
    dirs,
    faults,
    requests,
    close: () => new Promise((r) => server.close(r)),
  };
}
