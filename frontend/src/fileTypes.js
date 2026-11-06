// Tipos de ficheiro aceites: etiqueta curta e unidade de citação.
// O .docx não tem páginas fixas, por isso cita-se a ordem do bloco no documento ("Parte N"),
// tal como no backend (services/rag_engine.py: UNIT_LABELS).
export const FILE_KIND = { pdf: 'PDF', pptx: 'PPTX', docx: 'DOCX' }
export const UNIT_LABEL = { pdf: 'Pág.', pptx: 'Slide', docx: 'Parte' }
