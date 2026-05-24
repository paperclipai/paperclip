CREATE TABLE IF NOT EXISTS crewbrief_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id text NOT NULL,
  duty_day_id text,
  aircraft_tail text,
  document_type text NOT NULL DEFAULT 'crew_itinerary',
  original_filename text NOT NULL,
  storage_object_key text NOT NULL,
  content_type text NOT NULL DEFAULT 'application/pdf',
  byte_size integer NOT NULL,
  sha256 text NOT NULL,
  parser_status text NOT NULL DEFAULT 'pending',
  extraction_status jsonb,
  error_details text,
  uploaded_at timestamp with time zone NOT NULL DEFAULT now(),
  parsed_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cb_documents_trip_id_idx ON crewbrief_documents (trip_id);
CREATE INDEX IF NOT EXISTS cb_documents_parser_status_idx ON crewbrief_documents (parser_status);
CREATE INDEX IF NOT EXISTS cb_documents_uploaded_at_idx ON crewbrief_documents (uploaded_at);
