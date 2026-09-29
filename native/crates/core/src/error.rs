use std::{fmt, io};

#[repr(i32)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StatusCode {
    Ok = 0,
    InvalidArgument = 1,
    UnknownWorkspace = 2,
    UnknownJob = 3,
    AlreadyRunning = 4,
    Busy = 5,
    Io = 6,
    Database = 7,
    Internal = 8,
    BufferTooSmall = 9,
    Cancelled = 10,
}

#[derive(Debug)]
pub enum CoreError {
    InvalidArgument(&'static str),
    UnknownWorkspace,
    UnknownJob,
    AlreadyRunning,
    Busy,
    Io(io::Error),
    Database(rusqlite::Error),
    Walk(walkdir::Error),
    Internal(String),
    Cancelled,
}

impl CoreError {
    pub fn code(&self) -> StatusCode {
        match self {
            Self::InvalidArgument(_) => StatusCode::InvalidArgument,
            Self::UnknownWorkspace => StatusCode::UnknownWorkspace,
            Self::UnknownJob => StatusCode::UnknownJob,
            Self::AlreadyRunning => StatusCode::AlreadyRunning,
            Self::Busy => StatusCode::Busy,
            Self::Io(_) | Self::Walk(_) => StatusCode::Io,
            Self::Database(_) => StatusCode::Database,
            Self::Internal(_) => StatusCode::Internal,
            Self::Cancelled => StatusCode::Cancelled,
        }
    }
}

impl fmt::Display for CoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidArgument(message) => write!(f, "invalid argument: {message}"),
            Self::UnknownWorkspace => write!(f, "unknown workspace"),
            Self::UnknownJob => write!(f, "unknown index job"),
            Self::AlreadyRunning => write!(f, "an index job is already running for this workspace"),
            Self::Busy => write!(f, "resource is busy"),
            Self::Io(error) => write!(f, "filesystem error: {error}"),
            Self::Database(error) => write!(f, "index database error: {error}"),
            Self::Walk(error) => write!(f, "filesystem traversal error: {error}"),
            Self::Internal(message) => write!(f, "index pipeline error: {message}"),
            Self::Cancelled => write!(f, "index job cancelled"),
        }
    }
}

impl std::error::Error for CoreError {}

impl From<io::Error> for CoreError {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<rusqlite::Error> for CoreError {
    fn from(value: rusqlite::Error) -> Self {
        Self::Database(value)
    }
}

impl From<walkdir::Error> for CoreError {
    fn from(value: walkdir::Error) -> Self {
        Self::Walk(value)
    }
}
