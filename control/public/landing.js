// Landing page motion. Every animation shows a real PressBox step; the page is complete
// and readable without this file, without GSAP, and with prefers-reduced-motion.

// Motion tokens (Corporate archetype from the motion-design skill): one signature ease,
// three durations, one entrance pattern.
const EASE = 'power2.out';
const DURATION = { quick: 0.25, standard: 0.4, slow: 0.8 };
const ENTRANCE_RISE_PX = 16;
const TYPING_SECONDS_PER_CHARACTER = 0.03;
const PIPELINE_SCROLL_PER_STAGE = 70; // % of viewport height scrolled per pipeline stage
const WIDE_LAYOUT = '(min-width: 900px)';

pointLinksAtDeployment();

if (window.gsap && window.ScrollTrigger) {
  gsap.registerPlugin(ScrollTrigger);
  const media = gsap.matchMedia();
  media.add({ motionOK: '(prefers-reduced-motion: no-preference)', wide: WIDE_LAYOUT }, (context) => {
    if (!context.conditions.motionOK) return; // static page: every state already visible
    playHeroRequest();
    revealOnEnter('.stat, .card, .wall-demo, .diagram, .positioning');
    playWallMoment();
    if (!context.conditions.wide) {
      revealOnEnter('.stage');
      return undefined;
    }
    scrubPipeline();
    return restoreStaticPipeline; // gsap.matchMedia calls this when a condition stops matching
  });
}

/** Live-site and repository links follow this deployment's /api/state. */
function pointLinksAtDeployment() {
  fetch('/api/state')
    .then((res) => res.json())
    .then((state) => {
      document.querySelectorAll('.live-link').forEach((link) => (link.href = `${state.livePublicUrl}/`));
      if (state.repoUrl) document.querySelectorAll('.repo-link').forEach((link) => (link.href = state.repoUrl));
    })
    .catch(() => {}); // links keep their static defaults
}

/** Hero: the owner's request is typed, then lights the six stages it will pass through. */
function playHeroRequest() {
  const typed = document.querySelector('.typed');
  const fullText = typed.dataset.text;
  const typing = { characters: 0 };
  const stages = gsap.utils.toArray('.mini-pipeline li');
  const timeline = gsap.timeline({ defaults: { ease: EASE } });

  typed.textContent = '';
  gsap.set('.mini-status', { autoAlpha: 0, y: ENTRANCE_RISE_PX / 2 });
  timeline
    .from('.chat-bubble', { autoAlpha: 0, y: ENTRANCE_RISE_PX, duration: DURATION.standard })
    .to(typing, {
      characters: fullText.length,
      duration: fullText.length * TYPING_SECONDS_PER_CHARACTER,
      ease: 'none',
      onUpdate: () => {
        typed.textContent = fullText.slice(0, Math.round(typing.characters));
      },
    });
  stages.forEach((stage) => timeline.add(() => stage.classList.add('lit'), `+=${DURATION.standard}`));
  timeline.to('.mini-status', { autoAlpha: 1, y: 0, duration: DURATION.standard }, `+=${DURATION.quick}`);
}

/** Cards and blocks rise into place as they enter the viewport. */
function revealOnEnter(selector) {
  gsap.set(selector, { autoAlpha: 0, y: ENTRANCE_RISE_PX });
  ScrollTrigger.batch(selector, {
    start: 'top 88%',
    once: true,
    onEnter: (elements) => gsap.to(elements, { autoAlpha: 1, y: 0, duration: DURATION.standard, ease: EASE, stagger: 0.08 }),
  });
}

/**
 * How it works: the section pins and scrolling moves the request through the six stages.
 * Each stage lights its node, highlights its text, and plays what happens there (secrets
 * swapped for redactions, limits applied, agent log, gate checks, apply and destroy).
 */
function scrubPipeline() {
  const stages = gsap.utils.toArray('.stage');
  const nodes = gsap.utils.toArray('.node');
  const panels = gsap.utils.toArray('.panel');
  buildRedactionSwaps();
  document.querySelector('.pipeline-visual').classList.add('is-scrubbed');
  document.querySelector('.pipeline-pin').classList.add('is-pinned');

  gsap.set(panels, { autoAlpha: 0, y: ENTRANCE_RISE_PX });
  gsap.set(stages, { opacity: 0.35 });
  gsap.set('.track-fill', { scaleX: 0 });

  const timeline = gsap.timeline({
    defaults: { ease: EASE, duration: 1 },
    scrollTrigger: {
      trigger: '.pipeline-pin',
      pin: true,
      start: 'top top',
      end: `+=${PIPELINE_SCROLL_PER_STAGE * stages.length}%`,
      scrub: 0.6,
    },
  });

  // Within each stage: the previous panel leaves, then the new one enters, then its details
  // play. Offsets are fractions of one stage so panels never overlap mid-scroll.
  const LEAVE = 0.35;
  const ENTER_AT = 0.4;
  const DETAILS_AT = 0.75;
  stages.forEach((stage, index) => {
    const label = `stage-${index}`;
    timeline.addLabel(label);
    if (index > 0) {
      timeline
        .to(stages[index - 1], { opacity: 0.35, duration: LEAVE }, label)
        .to(panels[index - 1], { autoAlpha: 0, y: -ENTRANCE_RISE_PX, duration: LEAVE }, label);
    }
    timeline
      .to(stage, { opacity: 1, duration: LEAVE }, `${label}+=${ENTER_AT}`)
      .to(nodes[index], { backgroundColor: 'var(--pb-mint)', color: 'var(--pb-night)', duration: LEAVE }, `${label}+=${ENTER_AT}`)
      .to('.track-fill', { scaleX: index / (stages.length - 1) }, label)
      .to(panels[index], { autoAlpha: 1, y: 0, duration: LEAVE }, `${label}+=${ENTER_AT}`);

    const details = panels[index].querySelectorAll('.swap .after, .log, .check, .limits span');
    if (details.length) timeline.from(details, { autoAlpha: 0, x: -8, stagger: 0.12, duration: 0.4 }, `${label}+=${DETAILS_AT}`);
    panels[index].querySelectorAll('.swap .before').forEach((before) => timeline.to(before, { autoAlpha: 0, duration: 0.3 }, `${label}+=${DETAILS_AT}`));
  });
  timeline.to({}, { duration: 0.6 }); // hold the last stage before the pin releases
}

/** Wraps each redaction value so the original and the redacted text can crossfade. */
function buildRedactionSwaps() {
  document.querySelectorAll('.swap:not(.built)').forEach((swap) => {
    swap.dataset.from = swap.textContent;
    const before = document.createElement('span');
    before.className = 'before';
    before.textContent = swap.dataset.from;
    const after = document.createElement('span');
    after.className = 'after';
    after.textContent = swap.dataset.to;
    swap.replaceChildren(before, after);
    swap.classList.add('built');
  });
}

/** Back to the stacked, fully visible pipeline (narrow screen or reduced motion). */
function restoreStaticPipeline() {
  document.querySelector('.pipeline-visual').classList.remove('is-scrubbed');
  document.querySelector('.pipeline-pin').classList.remove('is-pinned');
  document.querySelectorAll('.swap.built').forEach((swap) => {
    swap.textContent = swap.dataset.from;
    swap.classList.remove('built');
  });
}

/** Containment moment: a request heads out of the sandbox, stops at the wall, the log explains. */
function playWallMoment() {
  const logLines = gsap.utils.toArray('.wall-log li');
  gsap.set(logLines, { autoAlpha: 0, x: -8 });
  gsap.set('.request-arrow', { scaleX: 0 });
  gsap.set('.impact', { autoAlpha: 0, scale: 0.6 });

  gsap
    .timeline({ defaults: { ease: EASE }, scrollTrigger: { trigger: '.wall-demo', start: 'top 70%', once: true } })
    .to('.request-arrow', { scaleX: 1, duration: DURATION.slow, ease: 'power1.in' })
    .to('.impact', { autoAlpha: 1, scale: 1, duration: DURATION.quick, ease: 'back.out(3)' })
    .to(logLines, { autoAlpha: 1, x: 0, duration: DURATION.standard, stagger: 0.35 }, '<')
    .to('.sandbox-box', { opacity: 0.35, borderStyle: 'dotted', duration: DURATION.slow }, '+=0.3')
    .add(() => {
      document.querySelector('.sandbox-label').textContent = 'sandbox · destroyed';
    });
}
