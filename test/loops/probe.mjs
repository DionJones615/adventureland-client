// A loop whose only job is to prove that the *mounted* script is what ran.
//
// CI mounts this directory and sets BOT_LOOP to this file, then asserts the lines below appear in
// the container log - which is only true if loops really are loadable from a bind mount.
export const meta = { name: "probe", description: "prints a marker and returns, for container smoke tests" };

export async function run({ log, sleep, counters }) {
	console.log("PROBE_LOOP_STARTED");
	let ticks = 0;
	while (ticks < 3) {
		ticks += 1;
		log("probe tick " + ticks);
		await sleep(200);
	}
	counters.failures = 0;
	console.log("PROBE_LOOP_TICKS=" + ticks);
}
