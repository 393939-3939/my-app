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
app.get("/", async (req, res) => {
  const users = await prisma.user.findMany();
  res.render("index", { users });
});

// ユーザー追加ボタンが押されたときの処理
app.post("/users", async (req, res) => {
  const { name, age } = req.body;
  if (name) {
    await prisma.user.create({
      data: { 
        name, 
        age: age ? parseInt(age) : null 
      }
    });
  }
  res.redirect("/");
});

app.listen(PORT, () => {
  console.log(`サーバーが http://localhost:${PORT} で動き出したぞ。`);
});
