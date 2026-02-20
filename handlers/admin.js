module.exports = function registerAdminHandlers(io, socket) {
  socket.on("review_comment", ({ id, action }) => {
    console.log(`Admin reviewed comment ${id}: ${action}`);

    io.emit("comment_reviewed", {
      id,
      status: action, // "approved" or "declined"
    });
  });
};
