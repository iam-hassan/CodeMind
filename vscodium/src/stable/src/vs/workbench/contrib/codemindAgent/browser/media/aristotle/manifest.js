/*---------------------------------------------------------------------------------------------
 *  GENERATED FILE — do not edit by hand.
 *  Written by scripts/aristotle-assets.py from the art in Pet/. Re-run that script
 *  after replacing the art; every number below is measured from it.
 *--------------------------------------------------------------------------------------------*/

// Frame geometry, state frame counts and the sleep segmentation for the composer pet.
// Read by media/aristotle.js. All frames in every strip share one size and one anchor,
// so a state change never moves the pet.
window.CodeMindAristotleFrames = {
	/* One frame of any strip, in asset pixels. The strips are authored at 2x and shown at
	   half size, so the pet stays crisp on a HiDPI display. */
	frameWidth: 262,
	frameHeight: 124,
	/* What the panel actually reserves, in CSS pixels. */
	displayWidth: 131,
	displayHeight: 62,
	fps: 12,
	/* Where the standing pet sits inside a frame, in display pixels. Every frame is the
	   same size and holds the same stage, so this rect is true for every state — it is what
	   the panel anchors against so the pet, not the frame's empty margin, meets the
	   composer edge. */
	body: { x: 29, y: 17, width: 86, height: 44 },
	/* Which column of idle.png is which gaze direction. */
	directions: { center: 0, top: 1, top_right: 2, right: 3, bottom_right: 4, bottom: 5, bottom_left: 6, left: 7, top_left: 8 },
	/* Frame counts per strip. */
	counts: { idle: 9, stretch: 40, butterfly: 40, sleep: 40 },
	/* Inclusive, 0-based frame ranges within sleep.png. */
	sleep: { intro: [0, 27], loop: [11, 27], outro: [28, 39] },
};
