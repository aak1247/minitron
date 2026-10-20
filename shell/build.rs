fn main() {
    let manifest_dir = std::path::PathBuf::from(
        std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set by Cargo"),
    );
    println!(
        "cargo:rerun-if-changed={}",
        manifest_dir.join("ui/shell.slint").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        manifest_dir.join("assets/icon.ico").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        manifest_dir.join("assets").display()
    );

    // 编译期把 Slint UI 编进二进制
    slint_build::compile_with_config(
        manifest_dir.join("ui/shell.slint"),
        slint_build::CompilerConfiguration::new().with_style("fluent-light".into()),
    )
    .expect("slint compile failed");

    // Windows: 嵌入 exe 图标和版本信息
    #[cfg(windows)]
    {
        let mut res = winres::WindowsResource::new();
        res.set_icon(
            manifest_dir
                .join("assets/icon.ico")
                .to_string_lossy()
                .as_ref(),
        );
        res.compile().expect("winres failed");
    }
}
