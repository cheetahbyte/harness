import type { CapabilityRef } from "./types";

type ModelContextContent = unknown;
export type CapabilityContextItem = {
	id: string;
	owner: "capability";
	capability: CapabilityRef;
	scope: "step" | "task";
	contentHash: string;
	content: ModelContextContent;
};
type TokenAccounting = {
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
		return this.active.map((item) => structuredClone(item));
	}

	admit(input: ContextAdmission): AdmissionResult {
		if (this.destroyed) throw new Error("task context is terminated");
		const item: CapabilityContextItem = {
			id: crypto.randomUUID(),
			owner: "capability",
			capability: structuredClone(input.capability),
			scope: input.scope,
			contentHash: input.contentHash,
			content: structuredClone(input.content),
		};
		const proposed = [...this.active, item];
		const result = this.account(proposed, input.accountant, item);
		if (result.status === "admitted") this.active = proposed;
		return result;
	}

	destroy(): void {
		this.active = [];
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
				...(item ? { item: structuredClone(item) } : {}),
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
