export type EffectClass = "read_only" | "mutating";
type MetadataTrust = "harness" | "operator_approved" | "provider_untrusted";
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
type SkillGrant = { maxLevel: SkillAuthorityLevel };
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
