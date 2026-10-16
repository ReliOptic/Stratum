"""Deterministic material property table with cited engineering constants."""

from __future__ import annotations

from dataclasses import dataclass

from stratum_cad.types import BasisType, EvidenceStatus


@dataclass(frozen=True)
class MaterialProps:
    """Material physical properties used by metrics and thermal simulation.

    Units:
    - density_g_cm3: g / cm^3 (1 cm^3 = 1000 mm^3)
    - cp_j_gk: J / (g * K)
    - k_w_mk: W / (m * K)
    """

    material_id: str
    density_g_cm3: float
    cp_j_gk: float
    k_w_mk: float
    status: EvidenceStatus
    basis_type: BasisType
    citation: str

    @property
    def density_g_mm3(self) -> float:
        """Return density in g / mm^3."""
        return self.density_g_cm3 * 1e-3


# Standard engineering handbook values (IncP / ASM reference properties).
MATERIAL_TABLE: dict[str, MaterialProps] = {
    "aluminum_6061": MaterialProps(
        material_id="aluminum_6061",
        density_g_cm3=2.70,
        cp_j_gk=0.896,
        k_w_mk=167.0,
        status="DOCUMENTED",
        basis_type="physics",
        citation="ASM Metals Handbook: Al 6061-T6",
    ),
    "copper_c110": MaterialProps(
        material_id="copper_c110",
        density_g_cm3=8.96,
        cp_j_gk=0.385,
        k_w_mk=388.0,
        status="DOCUMENTED",
        basis_type="physics",
        citation="ASM Metals Handbook: Cu C11000",
    ),
    "steel_304": MaterialProps(
        material_id="steel_304",
        density_g_cm3=8.00,
        cp_j_gk=0.500,
        k_w_mk=16.2,
        status="DOCUMENTED",
        basis_type="physics",
        citation="ASM Metals Handbook: AISI 304",
    ),
    "abs_plastic": MaterialProps(
        material_id="abs_plastic",
        density_g_cm3=1.05,
        cp_j_gk=1.400,
        k_w_mk=0.20,
        status="DOCUMENTED",
        basis_type="physics",
        citation="Polymer Handbook: Generic Molded ABS",
    ),
    "polycarbonate": MaterialProps(
        material_id="polycarbonate",
        density_g_cm3=1.20,
        cp_j_gk=1.200,
        k_w_mk=0.20,
        status="DOCUMENTED",
        basis_type="physics",
        citation="Polymer Handbook: Generic Polycarbonate",
    ),
    "fr4_composite": MaterialProps(
        material_id="fr4_composite",
        density_g_cm3=1.85,
        cp_j_gk=0.600,
        k_w_mk=0.30,
        status="DOCUMENTED",
        basis_type="physics",
        citation="IPC-4101: FR-4 Epoxy Glass Laminate",
    ),
    "storage_cell_composite": MaterialProps(
        material_id="storage_cell_composite",
        density_g_cm3=2.25,
        cp_j_gk=1.050,
        k_w_mk=3.50,
        status="DOCUMENTED",
        basis_type="physics",
        citation="Lumped electrochemical storage cell bulk properties",
    ),
    "ferrite_ceramic": MaterialProps(
        material_id="ferrite_ceramic",
        density_g_cm3=4.80,
        cp_j_gk=0.750,
        k_w_mk=4.00,
        status="DOCUMENTED",
        basis_type="physics",
        citation="Mnemonic MnZn Ferrite Core Bulk Reference",
    ),
    "copper_fr4": MaterialProps(
        material_id="copper_fr4",
        density_g_cm3=2.10,
        cp_j_gk=0.600,
        k_w_mk=2.50,
        status="DOCUMENTED",
        basis_type="physics",
        citation="IPC-4101: Cu-Clad FR-4 Effective Bulk Laminate",
    ),
    "layered_pouch": MaterialProps(
        material_id="layered_pouch",
        density_g_cm3=2.25,
        cp_j_gk=1.050,
        k_w_mk=3.50,
        status="DOCUMENTED",
        basis_type="physics",
        citation="Lumped electrochemical storage cell bulk properties",
    ),
    "stainless_steel": MaterialProps(
        material_id="stainless_steel",
        density_g_cm3=8.00,
        cp_j_gk=0.500,
        k_w_mk=16.2,
        status="DOCUMENTED",
        basis_type="physics",
        citation="ASM Metals Handbook: AISI 304",
    ),
}

ASSUMED_FALLBACK_MATERIAL = MaterialProps(
    material_id="assumed_generic_solid",
    density_g_cm3=1.50,
    cp_j_gk=1.000,
    k_w_mk=1.00,
    status="ASSUMED",
    basis_type="model_prior",
    citation="Fallback prior for unindexed material key",
)


def get_material_props(material_key: str) -> MaterialProps:
    """Resolve material properties by key, downgrading unknown materials to ASSUMED."""
    normalized = material_key.strip().lower()
    if normalized in MATERIAL_TABLE:
        return MATERIAL_TABLE[normalized]
    return MaterialProps(
        material_id=normalized or "unknown",
        density_g_cm3=ASSUMED_FALLBACK_MATERIAL.density_g_cm3,
        cp_j_gk=ASSUMED_FALLBACK_MATERIAL.cp_j_gk,
        k_w_mk=ASSUMED_FALLBACK_MATERIAL.k_w_mk,
        status="ASSUMED",
        basis_type="model_prior",
        citation=ASSUMED_FALLBACK_MATERIAL.citation,
    )
