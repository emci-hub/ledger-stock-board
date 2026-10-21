/**
 * Marks the current tab from the address, and keeps that tab inside the
 * header when the row scrolls sideways on a phone. Does not change page data.
 */
(function () {
  "use strict";

  var nav = document.querySelector("nav.site-nav");
  if (!nav) return;

  var path = window.location.pathname.replace(/\/+$/, "") || "/";
  var links = Array.prototype.slice.call(nav.querySelectorAll("a[href]"));
  var match = null;
  for (var i = 0; i < links.length; i++) {
    if (links[i].getAttribute("href") === path) match = links[i];
  }
  if (match) {
    for (var j = 0; j < links.length; j++) {
      if (links[j] === match) links[j].setAttribute("aria-current", "page");
      else links[j].removeAttribute("aria-current");
    }
  }

  var current = nav.querySelector("[aria-current='page']");
  if (!current || nav.scrollWidth <= nav.clientWidth + 1) return;
  var target = current.offsetLeft - (nav.clientWidth - current.offsetWidth) / 2;
  nav.scrollLeft = target > 0 ? target : 0;
})();
