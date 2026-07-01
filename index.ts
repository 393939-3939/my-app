import "dotenv/config";
import express from "express";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client";

// Prisma 7 の接続設定じゃ
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter, log: ["query"] });

const app = express();
const PORT = process.env.PORT || 8888;

// EJS を使う設定じゃ
app.set("view engine", "ejs");
app.set("views", "./views");
// フォームからのデータを受け取れるようにするぞ
app.use(express.urlencoded({ extended: true }));

// トップページ：ユーザー一覧を表示する
// app.get("/") の中でタスクも取得するように変更するぞ
app.get("/", async (req, res) => {
  const users = await prisma.user.findMany();
  const tasks = await prisma.task.findMany({ orderBy: { createdAt: "desc" } }); // 新しい順に取得
  res.render("index", { users, tasks }); // tasks も渡すようにする
});

// タスク追加用の POST エンドポイントを新しく作るぞ
app.post("/tasks", async (req, res) => {
  const content = req.body.content;
  if (content) {
    await prisma.task.create({ data: { content } });
  }
  res.redirect("/");
});

// ユーザー追加ボタンが押されたときの処理
app.post("/users", async (req, res) => {
  const name = req.body.name;
  // 文字列で送られてくるので数値に変換するぞ
  const age = Number(req.body.age);

  if (isNaN(age)) {
    res.status(400).send("年齢は数値でなければなりません。");
    return;
  }

  if (name) {
    // name と age の両方を保存するよう変更
    const newUser = await prisma.user.create({ data: { name, age } });
    console.log("追加:", newUser);
  }
  res.redirect("/");
});

app.listen(PORT, () => {
  console.log(`サーバーが http://localhost:${PORT} で動き出したぞ。`);
});
