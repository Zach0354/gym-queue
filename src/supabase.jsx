import { createClient } from '@supabase/supabase-js'

const supabaseUrl = 'https://ozsfipgehzbvrfmmjkrv.supabase.co'
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im96c2ZpcGdlaHpidnJmbW1qa3J2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQzNTkwMTgsImV4cCI6MjA4OTkzNTAxOH0.ICD2KX-MEvO4VWpLpT2gorzm94Nkg_D6GH0dCD1lzC4'

export const supabase = createClient(supabaseUrl, supabaseAnonKey)