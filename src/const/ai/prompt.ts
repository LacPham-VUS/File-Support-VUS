export const GEMINI_RED_CLEANUP_PROMPT = (
	'You will receive a scanned document image that contains red teacher markings (ticks, circles, underlines). ' +
	'Remove ONLY the handwriting/annotation strokes while preserving any structural red elements such as printed borders, layout frames, or decorative headings. ' +
	'Be aggressive enough to remove at least 100% of teacher ink, even if that requires broader hue coverage or slightly higher dilation/inpainting radii, but never erase printed layout elements. ' +
	'Specifically expand detection to catch faint pink, magenta, and orange-red remnants by keeping saturation thresholds no higher than 0.25 and value thresholds no higher than 0.2. ' +
	'Treat any annotation color that differs from the student’s original writing ink as teacher ink that must be removed. ' +
	'During the final double-check pass, erase any remaining teacher pixels by overwriting them with pure white (#FFFFFF) so the page looks clean like the provided samples. ' +
	'Double-check the cleaned output, especially cramped or narrow handwriting regions, to ensure no red strokes remain before finalizing parameters. ' +
	'Return ONLY valid JSON (no markdown) with recommended HSV thresholds to detect those red ink markings while keeping black text and the original red layout. ' +
	'Schema: {"sMin":0..1,"vMin":0..1,"hueA":[0..360,0..360],"hueB":[0..360,0..360],"dilateRadius":0..3,"inpaintRadius":1..5}. ' +
	'Use hue ranges around red (near 0 and near 360).'
);
