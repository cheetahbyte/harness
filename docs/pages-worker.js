import app from "./server.js";

export default {
	fetch(request, env, ctx) {
		if (new URL(request.url).pathname.startsWith("/assets/")) {
			return env.ASSETS.fetch(request);
		}

		return app.fetch(request, { env, ctx });
	},
};
