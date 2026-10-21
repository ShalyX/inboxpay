// Footage is optional context, never payment evidence. Playback is user-initiated.
const film = document.getElementById("studio-film");
if (film) {
  const pause = () => { if (!film.paused) film.pause(); };
  new IntersectionObserver(([entry]) => {
    if (!entry.isIntersecting) pause();
  }, { threshold: 0 }).observe(film);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) pause();
  });
  function unavailable() {
    film.hidden = true;
    film.parentElement.querySelector(".film-poster-fallback").hidden = false;
    film.parentElement.querySelector(".film-unavailable").hidden = false;
  }
  film.addEventListener("error", unavailable);
  film.querySelector("source").addEventListener("error", unavailable);
}
document.querySelectorAll(".business-photo img").forEach((image) => {
  const unavailable = () => {
    image.hidden = true;
    image.parentElement.querySelector(".media-empty").hidden = false;
  };
  image.addEventListener("error", unavailable);
  if (image.complete && !image.naturalWidth) unavailable();
});
