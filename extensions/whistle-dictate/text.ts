export function appendTranscript(existing: string, transcript: string): string {
	if (existing.length === 0) return transcript;
	if (transcript.length === 0 || /\s$/u.test(existing) || /^[\s,.;:!?%)}\]]/u.test(transcript)) {
		return existing + transcript;
	}
	return `${existing} ${transcript}`;
}

export function formatMicStatus(rms: number): string {
	const decibels = 20 * Math.log10(Math.max(rms, 0.000001));
	const level = Math.max(0, Math.min(1, (decibels + 60) / 48));
	const filled = Math.round(level * 6);
	const meter = Array.from({ length: 6 }, (_, index) => (index < filled ? "▇" : "▁")).join("");
	return `● ${meter} listening…`;
}
