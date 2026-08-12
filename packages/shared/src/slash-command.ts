export function slashCommandPattern(): RegExp {
	return /(^|\s)\/([a-z0-9-]+)(?=$|\s|[.,!?;:])/g;
}
