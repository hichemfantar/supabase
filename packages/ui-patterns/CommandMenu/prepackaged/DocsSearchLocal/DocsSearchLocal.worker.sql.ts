export const CREATE_VECTOR_EXTENSION = 'create extension if not exists vector;'

export const CREATE_PAGE_TABLE = `
create table if not exists page (
    id bigint primary key,
    path text,
    meta jsonb,
    type text,
    source text,
    content text,
    tsv tsvector generated always as (
        setweight(to_tsvector('simple', coalesce(meta ->> 'title', '')), 'A') ||
		    setweight(to_tsvector('simple', coalesce(meta ->> 'subtitle', '')), 'B') ||
			setweight(to_tsvector('simple', coalesce(meta ->> 'description', '')), 'C') ||
            setweight(to_tsvector('simple', coalesce(content, '')), 'D')
    ) stored
)
`.trim()

export const CREATE_PAGE_SECTION_TABLE = `
create table if not exists page_section (
    id bigint primary key,
    page_id bigint references page (id) on delete cascade,
    slug text,
    heading text,
    rag_ignore boolean,
    hf_embedding vector(384)
)
`.trim()

export const INSERT_PAGES = `
insert into page (
    id,
    path,
    meta,
    type,
    source,
    content
) values (
    $1,
    $2,
    $3,
    $4,
    $5,
    $6
)
`.trim()

export const INSERT_PAGE_SECTIONS = `
insert into page_section (
    id,
    page_id,
    slug,
    heading,
    rag_ignore,
    hf_embedding
) values (
    $1,
    $2,
    $3,
    $4,
    $5,
    $6
)
`.trim()

export const SEARCH_EMBEDDINGS = `
select * from (
	select
		*,
		row_number(*) over (partition by id order by match_score desc) as disambiguator
	from (
		with semantic_match as (
			select
				*,
				(page_section.hf_embedding <#> $1) * -1 as match_score
			from page_section
			where (page_section.hf_embedding <#> $1) * -1 > $2	
			order by match_score desc
			limit 10
		)
		select
			page.id,
			page.path,
			page.type,
			page.meta ->> 'title' as title,
			page.meta ->> 'subtitle' as subtitle,
			page.meta ->> 'description' as description,
			array_agg(semantic_match.heading) filter (where semantic_match.heading is not null) as headings,
			array_agg(semantic_match.slug) filter (where semantic_match.slug is not null) as slugs,
			'semantic' as match_type,
			max(semantic_match.match_score) as match_score
		from page
		join semantic_match on semantic_match.page_id = page.id
		group by page.id
		union all (
			select
				page.id,
				page.path,
				page.type,
				page.meta ->> 'title' as title,
				page.meta ->> 'subtitle' as subtitle,
				page.meta ->> 'description' as description,
				'{}' as headings,
				'{}' as slugs,
				'fts' as match_type,
				least(1,
					-- Weighting factor determined by trial and error
					ts_rank('{0.01, 0.1, 0.2, 1.0}', page.tsv, websearch_to_tsquery('simple', $3), 1) * 100
				) as match_score
			from page
			join page_section on page_section.page_id = page.id
			where page.tsv @@ websearch_to_tsquery('simple', $3)
			group by page.id
			order by match_score desc
			limit 20
		)
	)
)
where disambiguator = 1
order by match_score desc
limit 10
;
`.trim()
