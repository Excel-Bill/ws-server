const { Server } = require("socket.io");
const handleConnection = require("../handlers/connection");

module.exports = function initSocket(server) {
  const io = new Server(server, {
    cors: {
      origin: "*", // restrict in production
      methods: ["GET", "POST"],
    },
  });

  io.on("connection", (socket) => {
    handleConnection(io, socket);
  });
};
