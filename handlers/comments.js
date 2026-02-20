module.exports = function registerCommentHandlers(io, socket) {
  socket.on("submit_comment", (data) => {
    console.log("New comment received:", data);

    // TODO: Save to database
    // For now simulate pending review

    io.emit("comment_pending", {
      id: Date.now(),
      ...data,
      status: "pending",
    });
  });
};
