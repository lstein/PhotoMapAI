"""
Abstract base class for Invoke metadata modules.
This class is used to define the interface for formatting metadata from Invoke modules.
"""

from abc import ABC, abstractmethod
from typing import Annotated, Any, List, Literal, Optional, Union

from pydantic import BaseModel, Field


# some common types used across multiple modules
class Model(BaseModel):
    name: str
    base: Optional[str] = None
    hash: Optional[str] = None
    key: Optional[str] = None
    type: Optional[str] = None


class Lora(BaseModel):
    model: Model
    weight: float
    is_enabled: bool = True


class IPAdapter(BaseModel):
    model_name: str
    image_name: Optional[str] = None
    image_data: Optional[str] = None
    weight: Optional[float] = None
    image_influence: Optional[str] = None
    method: Optional[str] = None
    begin_step_percent: Optional[float] = None
    end_step_percent: Optional[float] = None


class ControlNet(BaseModel):
    model_name: str
    image_name: Optional[str] = None
    image_data: Optional[str] = None
    weight: Optional[float] = None
    image_influence: Optional[str] = None
    begin_step_percent: Optional[float] = None
    end_step_percent: Optional[float] = None
    control_mode: Optional[str] = None


# abstract base class properties
class InvokeMetadataModule(ABC):
    @property
    @abstractmethod
    def metadata_version(self) -> int:
        pass

    @property
    @abstractmethod
    def positive_prompt(self) -> str:
        pass

    @property
    @abstractmethod
    def negative_prompt(self) -> Optional[str]:
        pass

    @property
    @abstractmethod
    def model(self) -> Optional[Model]:
        pass

    @property
    @abstractmethod
    def refiner_model(self) -> Optional[Model]:
        pass

    @property
    @abstractmethod
    def vae_model(self) -> Optional[Model]:
        pass

    @property
    @abstractmethod
    def scheduler(self) -> Optional[str]:
        pass

    @property
    @abstractmethod
    def steps(self) -> Optional[int]:
        pass

    @property
    @abstractmethod
    def refiner_steps(self) -> Optional[int]:
        pass

    @property
    @abstractmethod
    def cfg_scale(self) -> Optional[float]:
        pass

    @property
    @abstractmethod
    def cfg_rescale_multiplier(self) -> Optional[float]:
        pass

    @property
    @abstractmethod
    def refiner_cfg_scale(self) -> Optional[float]:
        pass

    @property
    @abstractmethod
    def guidance(self) -> Optional[int | float]:
        pass

    @property
    @abstractmethod
    def width(self) -> Optional[int]:
        pass

    @property
    @abstractmethod
    def height(self) -> Optional[int]:
        pass

    @property
    @abstractmethod
    def seed(self) -> Optional[int]:
        pass

    @property
    @abstractmethod
    def denoise_strength(self) -> Optional[float]:
        pass

    @property
    @abstractmethod
    def refiner_denoise_start(self) -> Optional[float]:
        pass

    @property
    @abstractmethod
    def clip_skip(self) -> Optional[int]:
        pass

    @property
    @abstractmethod
    def seamless_x(self) -> Optional[bool]:
        pass

    @property
    @abstractmethod
    def seamless_y(self) -> Optional[bool]:
        pass

    @property
    @abstractmethod
    def refiner_positive_aesthetic_score(self) -> Optional[float]:
        pass

    @property
    @abstractmethod
    def refiner_negative_aesthetic_score(self) -> Optional[float]:
        pass
