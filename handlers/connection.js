const registerCommentHandlers = require("./comments");
const registerAdminHandlers = require("./admin");

module.exports = function handleConnection(io, socket) {
  console.log(`Client connected: ${socket.id}`);

  registerCommentHandlers(io, socket);
  registerAdminHandlers(io, socket);

  socket.on("disconnect", () => {
    console.log(`Client disconnected: ${socket.id}`);
  });
};
