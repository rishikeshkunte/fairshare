(function () {
  var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function track(name, data) {
    try {
      if (typeof window.va === "function") window.va("event", { name: name, data: data || {} });
    } catch (_) { /* ignore */ }
    try {
      if (typeof window.plausible === "function") window.plausible(name, { props: data || {} });
    } catch (_) { /* ignore */ }
  }
  window.fairshareTrack = track;

  // Any link into the app is a conversion click, wherever it appears.
  document.addEventListener("click", function (event) {
    var link = event.target.closest ? event.target.closest("a[href]") : null;
    if (!link) return;
    try {
      var url = new URL(link.href, window.location.href);
      if (url.origin === window.location.origin && url.pathname.indexOf("/app") === 0) {
        track("cta_click", { path: url.pathname, label: (link.textContent || "").trim().slice(0, 60) });
      }
    } catch (_) { /* ignore */ }
  });

  var amount = document.getElementById("demo-amount");
  var people = document.getElementById("demo-people");
  var each = document.getElementById("demo-each");
  var demoCta = document.getElementById("demo-cta");
  var demoStarted = false;

  function updateDemo() {
    if (!amount || !people || !each || !demoCta) return;
    var value = Number(amount.value);
    if (!isFinite(value) || value < 0) value = 0;
    var count = Math.max(2, Math.min(8, Math.round(Number(people.value) || 2)));
    var per = value / count;
    each.textContent = "\u20b9" + per.toLocaleString("en-IN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
    demoCta.href = "app/?intent=split&amount=" + encodeURIComponent(value.toFixed(2)) + "&people=" + count;
    if (!demoStarted && value > 0) {
      demoStarted = true;
      track("demo_start", { people: count });
    }
  }

  if (amount) amount.addEventListener("input", updateDemo);
  if (people) people.addEventListener("change", updateDemo);
  if (demoCta) {
    demoCta.addEventListener("click", function () {
      track("demo_complete", { amount: amount ? amount.value : "", people: people ? people.value : "" });
    });
  }
  updateDemo();

  var debtDemo = document.getElementById("debt-demo");
  if (debtDemo) {
    var buttons = debtDemo.querySelectorAll("[data-debt-view]");
    Array.prototype.forEach.call(buttons, function (button) {
      button.addEventListener("click", function () {
        var view = button.getAttribute("data-debt-view");
        debtDemo.classList.toggle("is-simplified", view === "simplified");
        Array.prototype.forEach.call(buttons, function (item) {
          item.setAttribute("aria-pressed", String(item === button));
        });
        track("debts_toggle", { view: view });
      });
    });
  }

  var sticky = document.getElementById("sticky-cta");
  if (sticky) {
    var onScroll = function () {
      sticky.classList.toggle("show", window.scrollY > 520);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }

  if (!reduceMotion && "IntersectionObserver" in window) {
    var revealTargets = document.querySelectorAll(".card, .usecase, .demo-card, .step, .section-head, .proof-box");
    if (revealTargets.length) {
      var observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            observer.unobserve(entry.target);
          }
        });
      }, { threshold: 0.12, rootMargin: "0px 0px -40px 0px" });
      Array.prototype.forEach.call(revealTargets, function (target) {
        target.classList.add("reveal");
        observer.observe(target);
      });
    }
  }
  var heroVisual = document.getElementById("hero-film");
  var filmCard = heroVisual ? heroVisual.querySelector(".film-card") : null;
  if (heroVisual && filmCard && !reduceMotion && window.matchMedia && window.matchMedia("(hover: hover)").matches) {
    heroVisual.addEventListener("pointermove", function (event) {
      var rect = heroVisual.getBoundingClientRect();
      var px = (event.clientX - rect.left) / rect.width - 0.5;
      var py = (event.clientY - rect.top) / rect.height - 0.5;
      filmCard.style.setProperty("--ry", (px * 7).toFixed(2) + "deg");
      filmCard.style.setProperty("--rx", (-py * 6).toFixed(2) + "deg");
    });
    heroVisual.addEventListener("pointerleave", function () {
      filmCard.style.setProperty("--ry", "0deg");
      filmCard.style.setProperty("--rx", "0deg");
    });
  }

  var film = document.getElementById("hero-film");
  var filmToggle = document.getElementById("film-toggle");
  var filmProgress = document.getElementById("film-progress");
  var filmScenes = film ? film.querySelectorAll(".film-scene") : [];
  var filmSteps = film ? film.querySelectorAll("[data-film-step]") : [];
  var filmIndex = 0;
  var filmTimer = 0;
  var filmPlaying = true;

  function showFilmScene(index) {
    if (!filmScenes.length) return;
    filmIndex = index % filmScenes.length;
    Array.prototype.forEach.call(filmScenes, function (scene, sceneIndex) {
      scene.classList.toggle("is-active", sceneIndex === filmIndex);
    });
    Array.prototype.forEach.call(filmSteps, function (step, stepIndex) {
      step.classList.toggle("is-current", stepIndex === filmIndex);
    });
    if (filmProgress) {
      filmProgress.classList.remove("is-running");
      void filmProgress.offsetWidth;
      filmProgress.classList.add("is-running");
    }
  }

  function scheduleFilm() {
    if (!filmPlaying || reduceMotion) return;
    clearTimeout(filmTimer);
    filmTimer = window.setTimeout(function () {
      showFilmScene(filmIndex + 1);
      scheduleFilm();
    }, 3200);
  }

  if (filmScenes.length) {
    if (reduceMotion) {
      film.classList.add("no-motion");
      showFilmScene(0);
      if (filmToggle) filmToggle.hidden = true;
    } else {
      showFilmScene(0);
      scheduleFilm();
      if (filmToggle) {
        filmToggle.addEventListener("click", function () {
          filmPlaying = !filmPlaying;
          filmToggle.setAttribute("aria-pressed", String(!filmPlaying));
          filmToggle.textContent = filmPlaying ? "Pause" : "Play";
          filmToggle.setAttribute("aria-label", filmPlaying ? "Pause the demo" : "Play the demo");
          if (filmPlaying) {
            showFilmScene(filmIndex);
            scheduleFilm();
          } else {
            clearTimeout(filmTimer);
            if (filmProgress) filmProgress.classList.remove("is-running");
          }
          track("film_toggle", { playing: filmPlaying });
        });
      }
    }
  }
})();
