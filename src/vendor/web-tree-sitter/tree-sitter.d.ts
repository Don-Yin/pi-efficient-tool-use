export interface Node {
	readonly type: string;
	readonly text: string;
	readonly startIndex: number;
	readonly isNamed: boolean;
	readonly namedChildCount: number;
	readonly namedChildren: Array<Node | null>;
	readonly children: Array<Node | null>;
	readonly hasError: boolean;
	readonly firstNamedChild: Node | null;
	childForFieldName(fieldName: string): Node | null;
	childrenForFieldName(fieldName: string): Array<Node | null>;
	descendantsOfType(types: string | string[]): Array<Node | null>;
}

export interface Tree {
	readonly rootNode: Node;
	delete(): void;
}

export class Language {
	static load(path: string): Promise<Language>;
}

export class Parser {
	static init(): Promise<void>;
	setLanguage(language: Language): void;
	parse(input: string): Tree | null;
}
