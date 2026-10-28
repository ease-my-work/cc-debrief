// .sql files are bundled as text (tsup loader; a matching plugin in vitest.config.ts).
declare module "*.sql" {
	const text: string;
	export default text;
}
