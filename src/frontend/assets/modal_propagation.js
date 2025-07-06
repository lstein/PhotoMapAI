document.addEventListener("DOMContentLoaded", function () {
    var modalContent = document.getElementById("modal-content");
    if (modalContent) {
        modalContent.addEventListener("click", function (event) {
            event.stopPropagation();
        });
    }
});
