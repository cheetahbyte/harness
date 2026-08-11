import { createHash } from "node:crypto";

export type EffectClass = "read_only" | "mutating";
export type MetadataTrust =
	| "harness"
	| "operator_approved"
	| "provider_untrusted";
export type HashScheme =
	| "raw-sha256-v1"
	| "jcs-sha256-v1"
	| "jcs-hmac-sha256-v1";
export type ProviderBindingRef = {
	providerId: string;
	bindingGeneration: string;
};
export type CapabilityRef = {
	id: string;
	catalogGeneration: string;
	contractHash: string;
	contractHashScheme: "jcs-sha256-v1";
	providerBinding: ProviderBindingRef;
};
export type ToolAuthorityLevel =
	| "none"
	| "discover"
	| "inspect"
	| "load"
	| "execute";
export type SkillAuthorityLevel = "none" | "discover" | "inspect" | "activate";
export type ConfirmationPolicy = "none" | "confirm_each" | "confirm_once";
export type ToolGrant = {
	maxLevel: ToolAuthorityLevel;
	confirmation: ConfirmationPolicy;
};
export type SkillGrant = { maxLevel: SkillAuthorityLevel };
export type CapabilityGrant =
	| ({ kind: "tool" } & ToolGrant)
	| ({ kind: "skill" } & SkillGrant);

type DiscoveryMetadata = {
	id: string;
	name: string;
	description: string;
	tags?: readonly string[];
	providerDisplayName: string;
	metadataTrust: MetadataTrust;
	modelDiscoverable?: boolean;
	providerBinding: ProviderBindingRef;
};
export type ToolCapabilityInput = DiscoveryMetadata & {
	kind: "tool";
	schema: unknown;
	effect?: EffectClass;
};
export type SkillCapabilityInput = DiscoveryMetadata & {
	kind: "skill";
	manifestHash: string;
	bodyHash: string;
};
export type CapabilityInput = ToolCapabilityInput | SkillCapabilityInput;

export type InspectedCapability = {
	ref: CapabilityRef;
	kind: CapabilityInput["kind"];
	name: string;
	description: string;
	tags: readonly string[];
	providerDisplayName: string;
	metadataTrust: Exclude<MetadataTrust, "provider_untrusted">;
	contract:
		| { schema: unknown; effect: EffectClass }
		| { manifestHash: string; bodyHash: string };
};
export type DiscoveryItem = Omit<InspectedCapability, "contract">;
export type DiscoveryOptions = {
	kind?: CapabilityInput["kind"];
	limit?: number;
	cursor?: string;
};
export type DiscoveryPage = {
	items: DiscoveryItem[];
	nextCursor?: string;
	analyzerVersion: "lexical-v1";
};
export type InitialGrants = {
	tool: ToolGrant | Readonly<Record<string, ToolGrant>>;
	skill: SkillGrant | Readonly<Record<string, SkillGrant>>;
};

type CapabilityRecord = InspectedCapability & { modelDiscoverable: boolean };
const toolLevels: readonly ToolAuthorityLevel[] = [
	"none",
	"discover",
	"inspect",
	"load",
	"execute",
];
const skillLevels: readonly SkillAuthorityLevel[] = [
	"none",
	"discover",
	"inspect",
	"activate",
];

export class CapabilityCatalog {
	readonly generation: string;
	private readonly records = new Map<string, CapabilityRecord>();
	private readonly bindings = new Map<
		string,
		Map<string, Map<string, string>>
	>();
	private readonly revoked = new Set<string>();
	private readonly disabledProviders = new Set<string>();

	constructor(
		inputs: readonly CapabilityInput[],
		generation: string = crypto.randomUUID(),
	) {
		this.generation = generation;
		for (const input of inputs) {
			if (this.records.has(input.id))
				throw new Error(`duplicate capability id: ${input.id}`);
			const contract =
				input.kind === "tool"
					? { schema: input.schema, effect: input.effect ?? "mutating" }
					: { manifestHash: input.manifestHash, bodyHash: input.bodyHash };
			const ref = {
				id: input.id,
				catalogGeneration: generation,
				contractHash: structuredHash({ kind: input.kind, contract }),
				contractHashScheme: "jcs-sha256-v1",
				providerBinding: { ...input.providerBinding },
			};
			const trusted = input.metadataTrust !== "provider_untrusted";
			const record = {
				ref,
				kind: input.kind,
				name: input.name,
				description: trusted ? bounded(input.description, 2_000) : "",
				tags: Object.freeze(
					[...(input.tags ?? [])].map((tag) => bounded(tag, 100)),
				),
				providerDisplayName: bounded(input.providerDisplayName, 200),
				metadataTrust: input.metadataTrust as CapabilityRecord["metadataTrust"],
				contract,
				modelDiscoverable: trusted && input.modelDiscoverable !== false,
			} as CapabilityRecord;
			this.records.set(input.id, freeze(record));
			this.setBinding(input.providerBinding, ref.contractHash, input.id);
		}
	}

	snapshot(grants: InitialGrants): CapabilitySnapshot {
		return new CapabilitySnapshot(this, [...this.records.values()], grants);
	}

	setBinding(
		binding: ProviderBindingRef,
		contractHash: string,
		capabilityId?: string,
	): void {
		let generations = this.bindings.get(binding.providerId);
		if (!generations) {
			generations = new Map();
			this.bindings.set(binding.providerId, generations);
		}
		let contracts = generations.get(binding.bindingGeneration);
		if (!contracts) {
			contracts = new Map();
			generations.set(binding.bindingGeneration, contracts);
		}
		if (capabilityId) contracts.set(capabilityId, contractHash);
		else
			for (const record of this.records.values())
				if (
					record.ref.providerBinding.providerId === binding.providerId &&
					record.ref.providerBinding.bindingGeneration ===
						binding.bindingGeneration
				)
					contracts.set(record.ref.id, contractHash);
	}

	removeBinding(binding: ProviderBindingRef): void {
		this.bindings.get(binding.providerId)?.delete(binding.bindingGeneration);
	}

	revoke(capabilityId: string): void {
		this.revoked.add(capabilityId);
	}

	disableProvider(providerId: string): void {
		this.disabledProviders.add(providerId);
	}

	verifyExecution(ref: CapabilityRef): void {
		if (this.revoked.has(ref.id)) throw new Error("AUTHORIZATION_REVOKED");
		if (this.disabledProviders.has(ref.providerBinding.providerId))
			throw new Error("PROVIDER_DISABLED");
		const current = this.bindings
			.get(ref.providerBinding.providerId)
			?.get(ref.providerBinding.bindingGeneration)
			?.get(ref.id);
		if (!current) throw new Error("STALE_CAPABILITY");
		if (current !== ref.contractHash) throw new Error("STALE_CAPABILITY");
	}
}

export class CapabilitySnapshot {
	private readonly records: ReadonlyMap<string, CapabilityRecord>;
	private readonly grants = new Map<string, CapabilityGrant>();

	constructor(
		private readonly catalog: CapabilityCatalog,
		records: readonly CapabilityRecord[],
		initial: InitialGrants,
	) {
		this.records = new Map(records.map((record) => [record.ref.id, record]));
		for (const record of records)
			this.grants.set(
				record.ref.id,
				record.kind === "tool"
					? { kind: "tool", ...grantFor(initial.tool, record.ref.id) }
					: { kind: "skill", ...grantFor(initial.skill, record.ref.id) },
			);
	}

	list(options: DiscoveryOptions = {}): DiscoveryPage {
		return this.page(
			[...this.records.values()]
				.filter((record) => this.discoverable(record, options.kind))
				.sort((a, b) => a.ref.id.localeCompare(b.ref.id)),
			options,
		);
	}

	search(query: string, options: DiscoveryOptions = {}): DiscoveryPage {
		const terms = analyze(query);
		if (!terms.length) return this.list(options);
		const scored = [...this.records.values()]
			.filter((record) => this.discoverable(record, options.kind))
			.map((record) => ({ record, score: score(record, terms) }))
			.filter(({ score }) => score > 0)
			.sort(
				(a, b) =>
					b.score - a.score || a.record.ref.id.localeCompare(b.record.ref.id),
			)
			.map(({ record }) => record);
		return this.page(scored, options);
	}

	inspect(ref: CapabilityRef): InspectedCapability {
		const record = this.resolve(ref);
		if (!atLeast(this.grant(ref.id), "inspect"))
			throw new Error("AUTHORIZATION_DENIED");
		return cloneInspection(record);
	}

	reference(id: string): CapabilityRef {
		const record = this.records.get(id);
		if (!record || !this.discoverable(record))
			throw new Error("CAPABILITY_NOT_FOUND");
		return structuredClone(record.ref);
	}

	require(
		ref: CapabilityRef,
		action: "discover" | "inspect" | "load" | "execute" | "activate",
	): void {
		const record = this.resolve(ref);
		const grant = this.grant(ref.id);
		if (record.kind !== grant.kind) throw new Error("AUTHORIZATION_DENIED");
		const permitted =
			grant.kind === "tool"
				? action !== "activate" &&
					toolLevels.indexOf(grant.maxLevel) >= toolLevels.indexOf(action)
				: action !== "load" &&
					action !== "execute" &&
					skillLevels.indexOf(grant.maxLevel) >= skillLevels.indexOf(action);
		if (!permitted) throw new Error("AUTHORIZATION_DENIED");
	}

	resolve(ref: CapabilityRef): CapabilityRecord {
		const record = this.records.get(ref.id);
		if (
			!record ||
			ref.catalogGeneration !== this.catalog.generation ||
			ref.contractHash !== record.ref.contractHash ||
			ref.contractHashScheme !== "jcs-sha256-v1" ||
			ref.providerBinding.providerId !==
				record.ref.providerBinding.providerId ||
			ref.providerBinding.bindingGeneration !==
				record.ref.providerBinding.bindingGeneration
		)
			throw new Error("STALE_CAPABILITY");
		return record;
	}

	verifyCurrent(ref: CapabilityRef): InspectedCapability {
		const record = this.resolve(ref);
		this.catalog.verifyExecution(ref);
		return cloneInspection(record);
	}

	grant(id: string): CapabilityGrant {
		const grant = this.grants.get(id);
		if (!grant) throw new Error(`unknown capability: ${id}`);
		return { ...grant };
	}

	reduceGrant(id: string, after: CapabilityGrant): CapabilityGrant {
		const before = this.grant(id);
		if (before.kind !== after.kind) throw new Error("grant kind cannot change");
		if (!grantIsReduction(before, after))
			throw new Error("authority ceiling cannot grow");
		this.grants.set(id, { ...after });
		return before;
	}

	private discoverable(
		record: CapabilityRecord,
		kind?: CapabilityInput["kind"],
	): boolean {
		return (
			record.modelDiscoverable &&
			(!kind || record.kind === kind) &&
			atLeast(this.grant(record.ref.id), "discover")
		);
	}

	private page(
		records: readonly CapabilityRecord[],
		options: DiscoveryOptions,
	): DiscoveryPage {
		const limit = Math.min(100, Math.max(1, options.limit ?? 20));
		const offset = cursorOffset(options.cursor);
		const selected = records.slice(offset, offset + limit);
		return {
			items: selected.map(discoveryItem),
			...(offset + limit < records.length
				? { nextCursor: String(offset + limit) }
				: {}),
			analyzerVersion: "lexical-v1",
		};
	}
}

export type ModelContextContent = unknown;
export type CapabilityContextItem = {
	id: string;
	owner: "capability";
	capability: CapabilityRef;
	scope: "step" | "task";
	contentHash: string;
	content: ModelContextContent;
};
export type TokenAccounting = {
	modelId: string;
	serializerVersion: string;
	method: "local_exact" | "provider_count" | "conservative_estimate";
	estimatedInputTokens: number;
	safetyMarginTokens: number;
	admittedInputCeiling: number;
};
export interface TokenAccountant {
	modelId: string;
	serializerVersion: string;
	method: TokenAccounting["method"];
	count(request: unknown): number;
}
export type AdmissionResult =
	| {
			status: "admitted";
			item?: CapabilityContextItem;
			accounting: TokenAccounting;
	  }
	| {
			status: "rejected";
			estimatedRequiredTokens: number;
			availableTokens: number;
			safetyMarginTokens: number;
			evictionCandidates: string[];
			accounting: TokenAccounting;
	  };
export type ContextAdmission = {
	capability: CapabilityRef;
	scope: CapabilityContextItem["scope"];
	contentHash: string;
	content: ModelContextContent;
	accountant: TokenAccountant;
};

export class CapabilityContext {
	private active: CapabilityContextItem[] = [];
	private destroyed = false;
	private accounting: TokenAccounting | undefined;

	constructor(
		private readonly baseRequest: unknown,
		private readonly assemble: (
			baseRequest: unknown,
			items: readonly CapabilityContextItem[],
		) => unknown,
		private readonly budget = 8_000,
		private readonly safetyMarginTokens = 512,
	) {
		if (!Number.isSafeInteger(budget) || budget <= 0)
			throw new Error("context budget must be a positive integer");
		if (!Number.isSafeInteger(safetyMarginTokens) || safetyMarginTokens < 0)
			throw new Error("safety margin must be a non-negative integer");
	}

	items(): CapabilityContextItem[] {
		return this.active.map(cloneContextItem);
	}

	admit(input: ContextAdmission): AdmissionResult {
		if (this.destroyed) throw new Error("task context is terminated");
		const item: CapabilityContextItem = {
			id: crypto.randomUUID(),
			owner: "capability",
			capability: cloneRef(input.capability),
			scope: input.scope,
			contentHash: input.contentHash,
			content: structuredClone(input.content),
		};
		const proposed = [...this.active, item];
		const result = this.account(proposed, input.accountant, item);
		if (result.status === "admitted") {
			this.active = proposed;
			this.accounting = result.accounting;
		}
		return result;
	}

	remove(id: string): boolean {
		const before = this.active.length;
		this.active = this.active.filter((item) => item.id !== id);
		return this.active.length !== before;
	}

	removeStepItems(): void {
		this.active = this.active.filter((item) => item.scope !== "step");
	}

	reaccount(accountant: TokenAccountant): AdmissionResult {
		if (this.destroyed) throw new Error("task context is terminated");
		const result = this.account(this.active, accountant);
		if (result.status === "admitted") this.accounting = result.accounting;
		return result;
	}

	lastAccounting(): TokenAccounting | undefined {
		return this.accounting ? { ...this.accounting } : undefined;
	}

	destroy(): void {
		this.active = [];
		this.accounting = undefined;
		this.destroyed = true;
	}

	private account(
		items: readonly CapabilityContextItem[],
		accountant: TokenAccountant,
		item?: CapabilityContextItem,
	): AdmissionResult {
		const estimatedInputTokens = accountant.count(
			this.assemble(this.baseRequest, items),
		);
		if (!Number.isSafeInteger(estimatedInputTokens) || estimatedInputTokens < 0)
			throw new Error("token accountant returned an invalid count");
		const estimatedRequiredTokens =
			estimatedInputTokens + this.safetyMarginTokens;
		const accounting: TokenAccounting = {
			modelId: accountant.modelId,
			serializerVersion: accountant.serializerVersion,
			method: accountant.method,
			estimatedInputTokens,
			safetyMarginTokens: this.safetyMarginTokens,
			admittedInputCeiling: this.budget,
		};
		if (estimatedRequiredTokens <= this.budget)
			return {
				status: "admitted",
				...(item ? { item: cloneContextItem(item) } : {}),
				accounting,
			};
		return {
			status: "rejected",
			estimatedRequiredTokens,
			availableTokens: Math.max(0, this.budget - this.safetyMarginTokens),
			safetyMarginTokens: this.safetyMarginTokens,
			evictionCandidates: this.active.map((candidate) => candidate.id),
			accounting,
		};
	}
}

export function rawHash(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export function structuredHash(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function canonicalJson(value: unknown): string {
	if (value === null || typeof value === "boolean" || typeof value === "string")
		return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value))
			throw new Error("canonical JSON requires finite numbers");
		return JSON.stringify(value);
	}
	if (Array.isArray(value))
		return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		const entries = Object.keys(record)
			.sort()
			.map((key) => {
				const item = record[key];
				if (item === undefined)
					throw new Error("canonical JSON does not support undefined");
				return `${JSON.stringify(key)}:${canonicalJson(item)}`;
			});
		return `{${entries.join(",")}}`;
	}
	throw new Error(`canonical JSON does not support ${typeof value}`);
}

function bounded(value: string, max: number): string {
	if (typeof value !== "string" || !value.trim())
		throw new Error("capability metadata must be non-empty text");
	if (value.length > max)
		throw new Error("capability metadata exceeds size limit");
	return value;
}

function grantFor<T>(grant: T | Readonly<Record<string, T>>, id: string): T {
	if ("maxLevel" in (grant as object)) return grant as T;
	const selected = (grant as Readonly<Record<string, T>>)[id];
	if (!selected) throw new Error(`missing initial grant for ${id}`);
	return selected;
}

function atLeast(
	grant: CapabilityGrant,
	required: "discover" | "inspect",
): boolean {
	const current =
		grant.kind === "tool"
			? toolLevels.indexOf(grant.maxLevel)
			: skillLevels.indexOf(grant.maxLevel);
	const needed = required === "discover" ? 1 : 2;
	return current >= needed;
}

function grantIsReduction(
	before: CapabilityGrant,
	after: CapabilityGrant,
): boolean {
	if (before.kind === "tool" && after.kind === "tool") {
		const levelReduced =
			toolLevels.indexOf(after.maxLevel) <= toolLevels.indexOf(before.maxLevel);
		const confirmations: readonly ConfirmationPolicy[] = [
			"none",
			"confirm_once",
			"confirm_each",
		];
		return (
			levelReduced &&
			confirmations.indexOf(after.confirmation) >=
				confirmations.indexOf(before.confirmation)
		);
	}
	return (
		before.kind === "skill" &&
		after.kind === "skill" &&
		skillLevels.indexOf(after.maxLevel) <= skillLevels.indexOf(before.maxLevel)
	);
}

function analyze(value: string): string[] {
	return value
		.normalize("NFKC")
		.toLocaleLowerCase("en-US")
		.split(/[^\p{L}\p{N}]+/u)
		.filter(Boolean);
}

function score(record: CapabilityRecord, terms: readonly string[]): number {
	const name = record.name.normalize("NFKC").toLocaleLowerCase("en-US");
	const fields = {
		name: analyze(record.name),
		description: analyze(record.description),
		tags: record.tags.flatMap(analyze),
		provider: analyze(record.providerDisplayName),
		kind: analyze(record.kind),
	};
	return terms.reduce(
		(total, term) =>
			total +
			(name === term ? 100 : 0) +
			(fields.name.includes(term) ? 40 : 0) +
			(fields.tags.includes(term) ? 20 : 0) +
			(fields.description.includes(term) ? 10 : 0) +
			(fields.provider.includes(term) ? 5 : 0) +
			(fields.kind.includes(term) ? 1 : 0),
		0,
	);
}

function cursorOffset(cursor?: string): number {
	if (cursor === undefined) return 0;
	const offset = Number(cursor);
	if (!Number.isSafeInteger(offset) || offset < 0)
		throw new Error("invalid discovery cursor");
	return offset;
}

function discoveryItem(record: CapabilityRecord): DiscoveryItem {
	const {
		contract: _contract,
		modelDiscoverable: _discoverable,
		...item
	} = record;
	return structuredClone(item);
}

function cloneInspection(record: CapabilityRecord): InspectedCapability {
	const { modelDiscoverable: _discoverable, ...inspection } = record;
	return structuredClone(inspection);
}

function cloneRef(ref: CapabilityRef): CapabilityRef {
	return structuredClone(ref);
}

function cloneContextItem(item: CapabilityContextItem): CapabilityContextItem {
	return structuredClone(item);
}

function freeze<T>(value: T): T {
	if (value && typeof value === "object") {
		Object.freeze(value);
		for (const child of Object.values(value as Record<string, unknown>))
			freeze(child);
	}
	return value;
}
