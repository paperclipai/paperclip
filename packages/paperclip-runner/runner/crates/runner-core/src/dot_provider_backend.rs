//! Deployed Dot compatibility facade. Execution is shared with Muse through a closed codec.
pub use crate::external_provider_backend::{
    DotCommandExecutor, ExternalProviderDescriptor as DotProviderDescriptor,
    DOT_PROVIDER_STATE_FILE,
};
