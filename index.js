import http from "node:http";

// Renderなどの本番環境では PORT という環境変数でポート番号が指定されるので、
// それがあれば使い、なければ 8888 を使うようにするのじゃ。
const PORT = process.env.PORT || 8888;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  // 日本語が文字化けしないよう charset を指定するぞ
  res.setHeader("Content-Type", "text/plain; charset=utf-8");

  if (url.pathname === "/") {
    console.log("GET /");
    res.writeHead(200);
    res.end("こんにちは！");
  } else if (url.pathname === "/ask") {
    console.log("GET /ask");
    const q = url.searchParams.get("q") ?? "なにもない";
    res.writeHead(200);
    res.end(`お主の質問は '${q}' じゃな。`);
  } else {
    res.writeHead(404);
    res.end("ページが見つかりませぬ");
  }
});

server.listen(PORT, () => {
  console.log(`サーバーが動いておるぞ！ http://localhost:${PORT}`);
});
