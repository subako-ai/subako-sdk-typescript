// Drives `subako login` headlessly: approves the device code against the
// server and the mock OIDC issuer the way a browser would.
//
//   node testbed/login.mjs <path-to-subako-cli> <org> <email> <credentials-file> [server]
import { spawn } from "node:child_process";

const [cli, org, email, credentialsFile, server = "http://localhost:8080"] = process.argv.slice(2);
if (!cli || !org || !email || !credentialsFile) {
	console.error("usage: node testbed/login.mjs <subako-cli> <org> <email> <credentials-file> [server]");
	process.exit(2);
}

const noRedirect = { redirect: "manual" };

const hidden = (html, name) => {
	const match = html.match(new RegExp(`name="${name}" value="([^"]*)"`));
	if (!match) throw new Error(`${name} not found in:\n${html}`);
	return match[1];
};

const formAction = (html, pageUrl) => {
	const tag = html.slice(html.indexOf("<form")).split(">")[0];
	const match = tag.match(/action="([^"]*)"/);
	return new URL(match ? match[1].replaceAll("&amp;", "&") : "", pageUrl);
};

async function approve(userCode) {
	const device = await fetch(`${server}/device`, {
		...noRedirect,
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ code: userCode }),
	});
	const authorizeUrl = device.headers.get("location");
	if (!authorizeUrl) throw new Error(`POST /device answered ${device.status} without a Location`);

	const form = await fetch(authorizeUrl, noRedirect);
	const html = await form.text();
	const login = await fetch(formAction(html, authorizeUrl), {
		...noRedirect,
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			username: email,
			claims: JSON.stringify({ email, email_verified: true, name: "Local Developer" }),
		}),
	});
	const callbackUrl = login.headers.get("location");
	if (!callbackUrl) throw new Error(`IdP login answered ${login.status} without a Location`);

	const approveHtml = await (await fetch(callbackUrl, noRedirect)).text();
	const decided = await fetch(`${server}/device/approve`, {
		...noRedirect,
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			transaction_id: hidden(approveHtml, "transaction_id"),
			approve_token: hidden(approveHtml, "approve_token"),
			decision: "approve",
		}),
	});
	if (!decided.ok) throw new Error(`POST /device/approve answered ${decided.status}: ${await decided.text()}`);
}

const child = spawn(cli, ["login", "--org", org, "--server", server, "--credentials-file", credentialsFile], {
	env: { ...process.env, SUBAKO_NO_BROWSER: "1" },
	stdio: ["ignore", "pipe", "inherit"],
});

let output = "";
let approved = false;
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
	output += chunk;
	process.stderr.write(chunk);
	const match = output.match(/enter code: ([^)]+)\)/);
	if (match && !approved) {
		approved = true;
		approve(match[1]).catch((error) => {
			console.error(error);
			child.kill();
			process.exit(1);
		});
	}
});
child.on("exit", (code) => process.exit(code ?? 1));
