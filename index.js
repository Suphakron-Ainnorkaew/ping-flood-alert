const axios = require("axios");
const cheerio = require("cheerio");
const line = require("@line/bot-sdk");
const cron = require("node-cron");
const express = require("express");
const fs = require("fs");

const app = express();
app.use(express.json());

// ===== 1. ตั้งค่า LINE Bot =====
const config = {
  channelAccessToken: process.env.LINE_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};
const client = new line.Client(config);

// ===== 2. โหลด userId ที่บันทึกไว้ =====
let USERS = [];
if (fs.existsSync("users.json")) {
  USERS = JSON.parse(fs.readFileSync("users.json"));
}

// ===== 3. Webhook เก็บ userId คนที่ทักมา =====
app.post("/webhook", line.middleware(config), (req, res) => {
  Promise
    .all(req.body.events.map(handleEvent))
    .then(() => res.end())
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

async function handleEvent(event) {
  if (event.type === "message" && event.message.type === "text") {
    const userId = event.source.userId;

    if (!USERS.includes(userId)) {
      USERS.push(userId);
      fs.writeFileSync("users.json", JSON.stringify(USERS, null, 2));
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: "✅ บันทึกคุณในรายชื่อแจ้งเตือนน้ำท่วมแล้ว!"
      });
    } else {
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: "คุณอยู่ในรายชื่อแจ้งเตือนแล้วครับ ✅"
      });
    }
  }
}

// ===== 4. ฟังก์ชันดึงระดับน้ำ P.67 =====
async function getWaterLevel() {
  try {
    const url = "https://hydro-1.rid.go.th/Data/HD-04/houly/water_today.php";
    const res = await axios.get(url);
    const $ = cheerio.load(res.data);
    let level = null;

    $("table tr").each((i, el) => {
      const tds = $(el).find("td");
      if (tds.eq(0).text().trim() === "P.67") {
        level = parseFloat(tds.eq(4).text().trim());
      }
    });
    return level;
  } catch (err) {
    console.error("ดึงข้อมูลน้ำล้มเหลว:", err);
    return null;
  }
}

// ===== 5. ฟังก์ชันส่งแจ้งเตือน =====
async function sendAlert(level) {
  const msg = `⚠️ เตือนภัยน้ำปิง\nสถานี P.67: ${level} ม.\nโปรดเฝ้าระวังน้ำท่วม!`;
  for (let user of USERS) {
    try {
      await client.pushMessage(user, { type: "text", text: msg });
      console.log("ส่งแจ้งเตือนแล้วถึง:", user);
    } catch (err) {
      console.error("ส่งไม่สำเร็จ:", err);
    }
  }
}

// ===== 6. ตั้งเวลารันอัตโนมัติทุก 30 นาที =====
cron.schedule("*/30 * * * *", async () => {
  console.log("⏳ กำลังเช็กระดับน้ำ...");
  const level = await getWaterLevel();
  const threshold = 4.0; // เกณฑ์เตือน
  if (level && level >= threshold) {
    console.log("⚠️ น้ำเกินเกณฑ์ → ส่งแจ้งเตือน");
    await sendAlert(level);
  } else {
    console.log("ระดับน้ำปกติ:", level);
  }
});

// ===== 7. Run Server (Render ต้องใช้) =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
