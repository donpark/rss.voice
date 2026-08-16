const base = (process.env.TEST_SERVER_URL ?? "").replace(/\/$/, "");
if (!base) throw new Error("Set TEST_SERVER_URL to a running local Worker before running integration tests.");

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const email = `integration-${suffix}@example.test`;
const screenname = `itest${Date.now().toString(36).slice(-8)}`;
const responseJson = async (response) => {
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
  return response.json();
};

const created = await responseJson(await fetch(`${base}/createnewuser?email=${encodeURIComponent(email)}&name=${screenname}`));
const link = new URL(created.devMagicLink);
await fetch(link, {redirect: "manual"});
const auth = `emailaddress=${encodeURIComponent(email)}&emailcode=${encodeURIComponent(link.searchParams.get("code"))}`;

const firehose = new WebSocket(`${base.replace(/^http/, "ws")}/firehose`);
await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("firehose connection timed out")), 5000);
  firehose.addEventListener("open", () => {
    clearTimeout(timeout);
    resolve();
  }, {once: true});
  firehose.addEventListener("error", () => {
    clearTimeout(timeout);
    reject(new Error("firehose connection failed"));
  }, {once: true});
});
const firehoseMessage = new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("firehose broadcast timed out")), 5000);
  firehose.addEventListener("message", (event) => {
    clearTimeout(timeout);
    resolve(event.data);
  }, {once: true});
});

const parent = await responseJson(await fetch(`${base}/newpost?${auth}`, {
  method: "POST",
  body: JSON.stringify({markdowntext: "integration parent"}),
}));
const event = await firehoseMessage;
if (typeof event !== "string" || !event.startsWith("newItem\r")) throw new Error("firehose broadcast mismatch");
firehose.close();

const child = await responseJson(await fetch(`${base}/newpost?${auth}`, {
  method: "POST",
  body: JSON.stringify({markdowntext: "integration child", inReplyTo: parent.id}),
}));
const thread = await responseJson(await fetch(`${base}/getthread?id=${parent.id}`));
if (thread.replies?.[0]?.id !== child.id) throw new Error("recursive thread response mismatch");

const media = await responseJson(await fetch(`${base}/uploadmedia?${auth}&type=audio%2Fmpeg&encoding=raw`, {
  method: "POST",
  body: Buffer.from("integration audio"),
}));
const range = await fetch(media.url, {headers: {range: "bytes=0-10"}});
if (range.status !== 206 || await range.text() !== "integration") throw new Error("media range response mismatch");

const updatedWithMedia = await responseJson(await fetch(`${base}/updatepost?${auth}`, {
  method: "POST",
  body: JSON.stringify({
    id: parent.id,
    markdowntext: "integration edited with audio",
    enclosureUrl: media.url,
    enclosureType: "audio/mpeg",
    enclosureLength: media.size,
  }),
}));
if (updatedWithMedia.markdowntext !== "integration edited with audio" || updatedWithMedia.enclosureUrl !== media.url) {
  throw new Error("update enclosure response mismatch");
}
const updated = await responseJson(await fetch(`${base}/updatepost?${auth}`, {
  method: "POST",
  body: JSON.stringify({id: parent.id, markdowntext: "integration edited"}),
}));
if (updated.markdowntext !== "integration edited" || updated.enclosureUrl !== media.url) throw new Error("update response mismatch");
await responseJson(await fetch(`${base}/togglelike?${auth}&id=${parent.id}`, {method: "POST"}));
await responseJson(await fetch(`${base}/deletepost?${auth}&id=${child.id}`, {method: "POST"}));
console.log(`integration ok: parent=${parent.id}, media=${media.id}`);
