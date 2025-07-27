require("dotenv").config();
const axios = require("axios");
// const cheerio = require("cheerio"); // ไม่ใช้แล้ว
const line = require("@line/bot-sdk");
const cron = require("node-cron");
const express = require("express");
const fs = require("fs");
const bodyParser = require("body-parser");

const app = express();

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

// ===== 3. Webhook =====

// ✅ สำหรับ Verify (GET)
app.get("/webhook", (req, res) => {
  res.status(200).send("OK");
});

// ✅ สำหรับรับ Event (POST) — ใช้ raw body
app.post(
  "/webhook",
  bodyParser.raw({ type: "*/*" }),
  line.middleware(config),
  async (req, res) => {
    try {
      if (!req.body || !req.body.length) {
        return res.status(200).send("No events");
      }

      // ต้อง parse เอง เพราะตอนนี้เป็น Buffer
      const parsed = JSON.parse(req.body.toString("utf-8"));

      await Promise.all(parsed.events.map(handleEvent));
      res.status(200).end();
    } catch (err) {
      console.error("Webhook Error:", err);
      res.status(200).end(); // ✅ ตอบ 200 เพื่อให้ Verify ผ่าน
    }
  }
);

// ===== 3.1 ฟังก์ชันตอบกลับและบันทึก userId =====
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

// ===== 4. ฟังก์ชันดึงพยากรณ์ฝน เชียงใหม่ =====
// ใช้ OpenWeatherMap API (ฟรี สมัคร key ได้ที่ https://openweathermap.org/api)
// ใส่ API key ใน .env เช่น OWM_API_KEY=xxxx
async function getRainForecast() {
  try {
    const apiKey = process.env.OWM_API_KEY;
    if (!apiKey) throw new Error('No OpenWeatherMap API key');
    // Chiang Mai: lat=18.7883, lon=98.9853
    const url = `https://api.openweathermap.org/data/2.5/forecast?lat=18.7883&lon=98.9853&units=metric&lang=th&appid=${apiKey}`;
    const res = await axios.get(url);
    // หาค่าความน่าจะเป็นฝนใน 12 ชั่วโมงข้างหน้า
    const forecasts = res.data.list.slice(0, 4); // 3 ชม. x 4 = 12 ชม.
    // ถ้ามี rain หรือ weather main เป็น Rain ในช่วงใดช่วงหนึ่ง ให้แจ้งเตือน
    const willRain = forecasts.some(f => {
      if (f.rain && f.rain["3h"] && f.rain["3h"] > 0) return true;
      if (f.weather && f.weather.some(w => w.main === "Rain")) return true;
      return false;
    });
    // ดึงรายละเอียดช่วงที่ฝนตก (ถ้ามี)
    const rainTimes = forecasts.filter(f => (f.rain && f.rain["3h"] > 0) || (f.weather && f.weather.some(w => w.main === "Rain")));
    return {
      willRain,
      rainTimes: rainTimes.map(f => ({ time: f.dt_txt, desc: f.weather[0].description, amount: f.rain ? f.rain["3h"] : 0 }))
    };
  } catch (err) {
    console.error("ดึงข้อมูลพยากรณ์ฝนล้มเหลว:", err);
    return { willRain: false, rainTimes: [] };
  }
}

// ===== 5. ฟังก์ชันส่งแจ้งเตือนฝนตก =====
async function sendRainAlert(rainInfo) {
  let msg = `🌧️ แจ้งเตือนฝนตกในเชียงใหม่\n`;
  if (rainInfo.rainTimes.length > 0) {
    msg += rainInfo.rainTimes.map(rt => `• ${rt.time}: ${rt.desc} (${rt.amount} มม.)`).join("\n");
  } else {
    msg += "มีโอกาสเกิดฝนตกใน 12 ชั่วโมงข้างหน้า กรุณาเตรียมตัว!";
  }
  for (let user of USERS) {
    try {
      await client.pushMessage(user, { type: "text", text: msg });
      console.log("ส่งแจ้งเตือนฝนตกแล้วถึง:", user);
    } catch (err) {
      console.error("ส่งไม่สำเร็จ:", err);
    }
  }
}

// ===== 6. ตั้งเวลารันอัตโนมัติทุก 30 นาที =====
cron.schedule("*/30 * * * *", async () => {
  console.log("⏳ กำลังเช็กพยากรณ์ฝนเชียงใหม่...");
  const rainInfo = await getRainForecast();
  if (rainInfo.willRain) {
    console.log("🌧️ มีโอกาสฝนตก → ส่งแจ้งเตือน");
    await sendRainAlert(rainInfo);
  } else {
    console.log("อากาศปกติ ไม่มีฝนใน 12 ชม.ข้างหน้า");
  }
});

app.get("/rainforecast", async (req, res) => {
  const rainInfo = await getRainForecast();
  res.json(rainInfo);
});

// ===== 7. Run Server (Render ต้องใช้) =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
